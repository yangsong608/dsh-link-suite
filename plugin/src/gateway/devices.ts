/**
 * 设备注册表：配对、令牌、撤销。
 *
 * 这里解决的问题是：网关此前永远处于"未认证 viewer"，因为**没有任何地方**
 * 把 `conn.authenticated` 置真——配对流程本身不存在。设备表就是配对的结果。
 *
 * 三条纪律：
 *   1. 只有**哈希**落盘。令牌是 bearer 凭证，明文存进 devices.json 等于把它
 *      写进备份、同步盘、截图里。
 *   2. 撤销必须立即生效：`revoke()` 返回后，调用方负责断开该设备的在线连接。
 *   3. 配对码是短命的：TTL 过期即失效，且一次只能被消费一次。
 */

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

import type { DeviceRole } from '@dsh-link/protocol'

export interface DeviceRecord {
  readonly deviceId: string
  readonly label: string
  readonly role: DeviceRole
  readonly platform: string
  /** `sha256(token)`，十六进制。永远不存明文令牌。 */
  readonly tokenHash: string
  readonly pairedAt: number
  lastSeen: number
  revokedAt?: number
}

interface DevicesFile {
  version: 1
  devices: DeviceRecord[]
}

/** 一个等待 finish 的配对会话。 */
export interface PairSession {
  readonly code: string
  readonly createdAt: number
  readonly expiresAt: number
  /** PC 侧点过"允许"才为真；未确认前 finish 一律拒绝。 */
  approved: boolean
  /** 已经成功消费过，防重放。 */
  consumed: boolean
}

export interface PairedDevice {
  readonly device: DeviceInfoView
  /** 明文令牌只在这里出现一次，调用方交给设备后就不该再持有。 */
  readonly token: string
}

export interface DeviceInfoView {
  readonly deviceId: string
  readonly label: string
  readonly role: DeviceRole
  readonly platform: string
  readonly pairedAt: number
  readonly lastSeen: number
}

const TOKEN_BYTES = 32
const CODE_DIGITS = 6

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/** 定长比较，避免按字节早退泄漏令牌前缀。 */
function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.byteLength !== right.byteLength || left.byteLength === 0) return false
  return timingSafeEqual(left, right)
}

export class DeviceRegistry {
  readonly #file: string
  #devices: DeviceRecord[] = []
  #pairs = new Map<string, PairSession>()
  #loaded = false

  constructor(file: string) {
    this.#file = file
  }

  async load(): Promise<void> {
    if (this.#loaded) return
    try {
      const text = await fs.readFile(this.#file, 'utf8')
      const parsed = JSON.parse(text) as Partial<DevicesFile>
      if (Array.isArray(parsed.devices)) {
        this.#devices = parsed.devices.filter((d): d is DeviceRecord => typeof d?.deviceId === 'string')
      }
    } catch {
      this.#devices = []
    }
    this.#loaded = true
  }

  async #save(): Promise<void> {
    const body: DevicesFile = { version: 1, devices: this.#devices }
    await fs.mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
    await fs.writeFile(this.#file, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  // ── 读 ──────────────────────────────────────────────────────────────────

  /** 列出未撤销设备。撤销记录保留在文件里，但不出现在这里。 */
  list(): DeviceInfoView[] {
    return this.#devices
      .filter((d) => d.revokedAt === undefined)
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
        role: d.role,
        platform: d.platform,
        pairedAt: d.pairedAt,
        lastSeen: d.lastSeen,
      }))
  }

  get(deviceId: string): DeviceRecord | undefined {
    return this.#devices.find((d) => d.deviceId === deviceId && d.revokedAt === undefined)
  }

  getByHash(tokenHash: string): DeviceRecord | undefined {
    return this.#devices.find((d) => d.revokedAt === undefined && safeEqualHex(d.tokenHash, tokenHash))
  }

  tokenHashOf(token: string): string {
    return sha256(token)
  }

  /** 校验令牌并刷新 lastSeen。返回 undefined 表示令牌无效或设备已撤销。 */
  authenticate(token: string): DeviceRecord | undefined {
    if (typeof token !== 'string' || token.length === 0) return undefined
    const record = this.getByHash(sha256(token))
    if (record === undefined) return undefined
    record.lastSeen = Date.now()
    return record
  }

  // ── 配对 ────────────────────────────────────────────────────────────────

  /** 生成一个 6 位配对码，TTL 默认 120s。由 PC 侧展示，用户在手机上输入。 */
  startPair(ttlMs = 120_000): PairSession {
    const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0')
    const now = Date.now()
    const session: PairSession = {
      code,
      createdAt: now,
      expiresAt: now + ttlMs,
      approved: false,
      consumed: false,
    }
    this.#pairs.set(code, session)
    return session
  }

  /** PC 侧确认。只有确认过的码才能被 finish 消费。 */
  approvePair(code: string): boolean {
    const session = this.#pairs.get(code)
    if (session === undefined) return false
    if (session.consumed || session.expiresAt <= Date.now()) return false
    session.approved = true
    return true
  }

  /** 当前待确认的配对会话（给 PC 页面轮询展示）。已过期的顺手清掉。 */
  pendingPairs(): PairSession[] {
    const now = Date.now()
    for (const [code, session] of this.#pairs) {
      if (session.expiresAt <= now) this.#pairs.delete(code)
    }
    return [...this.#pairs.values()].filter((s) => !s.consumed)
  }

  /**
   * 完成配对。
   *
   * 前置条件全部不满足时返回 `{ ok: false, reason }` 而不是抛错——路由层要把
   * 这些原因映射成不同的 RPC 错误码，让 App 能说"码过期了"而不是"配对失败"。
   */
  async finishPair(input: {
    code: string
    label: string
    platform: string
    role?: DeviceRole
  }): Promise<
    | { ok: true; result: PairedDevice }
    | { ok: false; reason: 'unknown-code' | 'expired' | 'not-approved' | 'consumed' }
  > {
    const session = this.#pairs.get(input.code)
    if (session === undefined) return { ok: false, reason: 'unknown-code' }
    if (session.consumed) return { ok: false, reason: 'consumed' }
    if (session.expiresAt <= Date.now()) return { ok: false, reason: 'expired' }
    if (!session.approved) return { ok: false, reason: 'not-approved' }

    session.consumed = true
    this.#pairs.delete(input.code)

    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const now = Date.now()
    const record: DeviceRecord = {
      deviceId: `dev_${randomBytes(8).toString('hex')}`,
      label: input.label.trim() || '未命名设备',
      role: input.role ?? 'operator',
      platform: input.platform,
      tokenHash: sha256(token),
      pairedAt: now,
      lastSeen: now,
    }
    this.#devices.push(record)
    await this.#save()

    return {
      ok: true,
      result: {
        device: {
          deviceId: record.deviceId,
          label: record.label,
          role: record.role,
          platform: record.platform,
          pairedAt: record.pairedAt,
          lastSeen: record.lastSeen,
        },
        token,
      },
    }
  }

  // ── 撤销 ────────────────────────────────────────────────────────────────

  /**
   * 撤销设备。返回被撤销的 deviceId（未找到返回 undefined）。
   * 调用方拿它去断在线连接——表里删了但 socket 还活着，等于没撤销。
   */
  async revoke(deviceId: string): Promise<string | undefined> {
    const record = this.get(deviceId)
    if (record === undefined) return undefined
    record.revokedAt = Date.now()
    await this.#save()
    return record.deviceId
  }

  /** 测试与排障用：拿到撤销记录（含已撤销的）。 */
  all(): readonly DeviceRecord[] {
    return this.#devices
  }
}
