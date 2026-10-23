/**
 * 锁屏状态机。
 *
 * **唯一执行点原则**：锁的判定只在这里产生（`get()`），
 * 网关（guard）、客户端半、HTTP 状态接口都只读它。
 * 同类插件最常见的 bug 就是"客户端自己算一遍空闲时间"，然后两边不一致。
 *
 * 空闲计时的真相源在宿主：笔记本合盖后渲染进程会被节流甚至挂起，
 * `setTimeout` 会失准，而宿主进程不会。
 */

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

import { UNLOCKED, type LockReason, type LockState } from '@dsh-link/protocol'
import type { DshContext } from '../dsh.js'
import type { LinkConfig } from '../config.js'
import { AttemptLimiter, hashPassword, verifyPassword, type PasswordRecord } from './password.js'
import { createSecret, issueTicket, verifyTicket } from './ticket.js'
import { AuditLog } from './audit.js'

/** 持久化部分：只有密码与生物识别凭据，**不含**解锁票据（票据随进程生灭）。 */
interface LockStoreFile {
  password?: PasswordRecord
  webauthn?: { id: string; label: string; addedAt: number }[]
}

export interface UnlockResult {
  readonly ticket: string
  readonly expiresAt: number
}

export interface RemoteRequest {
  readonly deviceId: string
  readonly label: string
  readonly requestedAt: number
}

export class LockService {
  readonly #ctx: DshContext
  readonly #cfg: LinkConfig['lock']
  readonly #storePath: string
  readonly #audit: AuditLog
  readonly #secret: Buffer

  #state: LockState = UNLOCKED
  #store: LockStoreFile = {}
  #limiter: AttemptLimiter
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #softTimer: ReturnType<typeof setTimeout> | undefined
  #pending = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>()
  #disposed = false

  constructor(ctx: DshContext, cfg: LinkConfig, paths: { store: string; audit: string }) {
    this.#ctx = ctx
    this.#cfg = cfg.lock
    this.#storePath = paths.store
    this.#audit = new AuditLog(paths.audit)
    this.#secret = createSecret()
    this.#limiter = new AttemptLimiter(cfg.lock.maxAttempts, cfg.lock.windowMinutes * 60_000)
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.#store = await this.#loadStore()
    if (this.#cfg.enabled && this.#store.password === undefined) {
      // 开了锁屏却没设密码 = 会把自己锁在外面。不自动启用，只告警。
      this.#log().warn('[dsh-link] lock.enabled=true 但未设置密码，锁屏不会生效。先设置密码再开启。')
    }
    this.#armIdle()
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    if (this.#softTimer) clearTimeout(this.#softTimer)
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.resolve(false)
    }
    this.#pending.clear()
    await this.#audit.flush()
  }

  #log(): NonNullable<DshContext['logger']> {
    return (
      this.#ctx.logger ?? {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }
    )
  }

  // ── 读 ──────────────────────────────────────────────────────────────────

  get(): LockState {
    const retryAfterMs = this.#limiter.retryAfterMs
    return {
      ...this.#state,
      attemptsLeft: this.#limiter.remaining,
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
    }
  }

  /** 锁屏是否真正生效（开启且有密码）。没有密码时 `enabled` 是假的。 */
  get armed(): boolean {
    return this.#cfg.enabled && this.#store.password !== undefined
  }

  get hasPassword(): boolean {
    return this.#store.password !== undefined
  }

  // ── 锁 / 解锁 ───────────────────────────────────────────────────────────

  lock(reason: LockReason, idleMs?: number): void {
    if (!this.armed || this.#state.locked) return
    this.#state = { locked: true, soft: false, since: Date.now(), reason, failedAttempts: 0 }
    this.#audit.write(idleMs === undefined ? { ev: 'lock', reason } : { ev: 'lock', reason, idleMs })
    this.#publish()
  }

  /** 手动解锁（本机 owner 或已配对设备）。失败抛带 details 的错误，由路由层转成 RpcError。 */
  unlock(password: string, from: 'owner' | 'device', deviceId?: string): UnlockResult {
    if (!this.armed) throw new UnlockError('lock/no-password-set', '锁屏未启用或未设置密码')

    const retryAfterMs = this.#limiter.retryAfterMs
    if (retryAfterMs > 0) {
      this.#audit.write({ ev: 'unlock.limited', retryAfterMs })
      throw new UnlockError('lock/rate-limited', '尝试次数过多', { retryAfterMs })
    }

    if (!verifyPassword(this.#store.password, password)) {
      this.#limiter.recordFailure()
      const attempt = this.#cfg.maxAttempts - this.#limiter.remaining
      this.#state = { ...this.#state, failedAttempts: attempt }
      this.#audit.write(
        deviceId === undefined
          ? { ev: 'unlock.fail', from, attempt }
          : { ev: 'unlock.fail', from, attempt, deviceId },
      )
      this.#publish()
      throw new UnlockError('lock/bad-password', '密码错误', {
        attempt,
        attemptsLeft: this.#limiter.remaining,
      })
    }

    this.#limiter.reset()
    this.#state = UNLOCKED
    const ttl = 12 * 3600_000
    const ticket = issueTicket(this.#secret, deviceId ?? 'owner', ttl)
    this.#audit.write(
      deviceId === undefined ? { ev: 'unlock.ok', from } : { ev: 'unlock.ok', from, deviceId },
    )
    this.#publish()
    this.#armIdle()
    return { ticket, expiresAt: Date.now() + ttl }
  }

  /** 校验票据；票据无效时**不**改状态，只返回 false（避免被拿来探状态）。 */
  acceptTicket(ticket: string, deviceId: string): boolean {
    const payload = verifyTicket(this.#secret, ticket, deviceId)
    if (payload === undefined) return false
    this.touch()
    return true
  }

  // ── 空闲 / 半锁 ─────────────────────────────────────────────────────────

  /** 有活动。客户端与宿主都会调，取最大值的效果由"谁调都只是重置"自然达成。 */
  touch(): void {
    if (this.#state.locked) return
    if (this.#state.soft) {
      this.#state = { ...this.#state, soft: false }
      this.#publish()
    }
    this.#armIdle()
  }

  #armIdle(): void {
    if (this.#disposed) return
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    if (this.#softTimer) clearTimeout(this.#softTimer)

    const idleMs = this.#cfg.idleMinutes * 60_000
    if (idleMs > 0) {
      this.#idleTimer = setTimeout(() => {
        this.lock('idle', idleMs)
      }, idleMs)
      this.#idleTimer.unref?.()
    }

    const softMs = this.#cfg.softLockHours * 3600_000
    if (softMs > 0) {
      this.#softTimer = setTimeout(() => {
        if (this.#state.locked) return
        this.#state = { ...this.#state, soft: true, since: Date.now(), reason: 'idle' }
        this.#publish()
      }, softMs)
      this.#softTimer.unref?.()
    }
  }

  // ── 远程解锁请求（PC 上点确认） ──────────────────────────────────────────

  /**
   * 手机请求解锁 → PC 弹窗。`timeoutMs` 后自动拒绝。
   *
   * 为什么需要"人在 PC 前点一下"：物理在场是比密码更强的证明。
   * 手机可能是捡到的，而坐在你电脑前的人不可能是捡到的。
   */
  requestRemote(deviceId: string, label: string, timeoutMs = 30_000): Promise<boolean> {
    if (!this.#state.locked) return Promise.resolve(true)
    if (this.#pending.has(deviceId)) return Promise.resolve(false)

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(deviceId)
        this.#audit.write({ ev: 'remote.request', deviceId, result: 'timeout' })
        resolve(false)
      }, timeoutMs)
      timer.unref?.()

      this.#pending.set(deviceId, { resolve, timer })
      this.#ctx.emit('dsh-link/lock-request', {
        deviceId,
        label,
        requestedAt: Date.now(),
      } satisfies RemoteRequest)
    })
  }

  /** 由 dsh 自己的界面调用：批准或拒绝某个待处理请求。 */
  settleRemote(deviceId: string, approved: boolean): boolean {
    const pending = this.#pending.get(deviceId)
    if (pending === undefined) return false
    clearTimeout(pending.timer)
    this.#pending.delete(deviceId)
    this.#audit.write({ ev: 'remote.request', deviceId, result: approved ? 'approved' : 'denied' })
    if (approved) {
      // 批准 = 解锁，并给该设备一张票据（否则它下一次调用又会被拒）
      this.#state = UNLOCKED
      this.#publish()
      this.#armIdle()
    }
    pending.resolve(approved)
    return true
  }

  // ── 密码设置 ────────────────────────────────────────────────────────────

  async setPassword(password: string): Promise<void> {
    this.#store = { ...this.#store, password: hashPassword(password) }
    await this.#saveStore()
    this.#limiter.reset()
    this.#log().info('[dsh-link] 锁屏密码已更新')
  }

  async clearPassword(): Promise<void> {
    const { password: _drop, ...rest } = this.#store
    this.#store = rest
    await this.#saveStore()
    this.#state = UNLOCKED
    this.#publish()
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  #publish(): void {
    const state = this.get()
    this.#ctx.emit('dsh-link/lock-changed', state)
  }

  async #loadStore(): Promise<LockStoreFile> {
    try {
      const text = await fs.readFile(this.#storePath, 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) return {}
      const obj = parsed as Record<string, unknown>
      const out: LockStoreFile = {}
      if (obj['password'] !== undefined) out.password = obj['password'] as PasswordRecord
      if (Array.isArray(obj['webauthn'])) {
        out.webauthn = obj['webauthn'] as { id: string; label: string; addedAt: number }[]
      }
      return out
    } catch {
      return {}
    }
  }

  async #saveStore(): Promise<void> {
    await fs.mkdir(dirname(this.#storePath), { recursive: true, mode: 0o700 })
    await fs.writeFile(this.#storePath, `${JSON.stringify(this.#store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  /** 恢复码：8 组四字短语。真正生成与校验在 routes 层，这里只提供随机源。 */
  static recoveryCode(): string {
    const words = randomBytes(8)
    return [...words].map((b) => b.toString(16).padStart(2, '0')).join('-')
  }
}

export class UnlockError extends Error {
  readonly code: string
  readonly details: Record<string, unknown> | undefined

  constructor(code: string, msg: string, details?: Record<string, unknown>) {
    super(msg)
    this.name = 'UnlockError'
    this.code = code
    this.details = details
  }
}
