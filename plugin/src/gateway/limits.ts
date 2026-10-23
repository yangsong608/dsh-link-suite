/**
 * 网关准入闸门：建连限额、速率、帧上限、Origin 校验。
 *
 * 这些**全部在认证之前**执行。理由是攻击者不需要通过认证就能建连：
 * 局域网端口对同网段开放，一个循环脚本几秒内能灌上万个 socket，
 * 而这不需要猜对任何密码。
 */

import { MAX_CONTROL_FRAME_BYTES } from '@dsh-link/protocol'

/** 单 IP 并发上限。正常一个人用不超过 3 台设备。 */
export const MAX_CONN_PER_IP = 8
/** 全局并发上限。家用场景足够，且内存可控。 */
export const MAX_CONN_TOTAL = 64
/** 未认证连接必须在这个时间内完成认证，否则断开。 */
export const PRE_AUTH_TIMEOUT_MS = 10_000
/** 建连速率：每分钟每 IP 允许的次数（令牌桶，容量 = 速率）。 */
export const CONNECT_RATE_PER_MIN = 10

interface IpState {
  sockets: number
  bucket: number
  refilledAt: number
}

export type Admission =
  | { ok: true }
  | { ok: false; code: 429 | 403 | 413; reason: string }

/**
 * 连接与帧的准入控制。
 *
 * 单进程内存实现：网关是单宿主单进程的，不需要跨进程共享状态。
 */
export class AdmissionControl {
  #byIp = new Map<string, IpState>()
  #total = 0

  #stateFor(ip: string, now: number): IpState {
    let state = this.#byIp.get(ip)
    if (state === undefined) {
      state = { sockets: 0, bucket: CONNECT_RATE_PER_MIN, refilledAt: now }
      this.#byIp.set(ip, state)
    }
    // 按分钟补充令牌；满桶不再累加
    const elapsed = now - state.refilledAt
    if (elapsed >= 60_000) {
      const refill = Math.floor(elapsed / 60_000) * CONNECT_RATE_PER_MIN
      state.bucket = Math.min(CONNECT_RATE_PER_MIN, state.bucket + refill)
      state.refilledAt = now
    }
    return state
  }

  /** 接纳一条新连接。拒绝时给出 HTTP 状态与原因，调用方直接 destroy。 */
  admitConnection(ip: string, now = Date.now()): Admission {
    const state = this.#stateFor(ip, now)
    if (this.#total >= MAX_CONN_TOTAL) return { ok: false, code: 429, reason: 'too many connections' }
    if (state.sockets >= MAX_CONN_PER_IP) return { ok: false, code: 429, reason: 'too many connections from this address' }
    if (state.bucket <= 0) return { ok: false, code: 429, reason: 'connect rate exceeded' }
    state.bucket -= 1
    state.sockets += 1
    this.#total += 1
    return { ok: true }
  }

  /** 连接关闭（含未经准入就 destroy 的路径）时归还额度。幂等。 */
  releaseConnection(ip: string): void {
    const state = this.#byIp.get(ip)
    if (state === undefined) return
    if (state.sockets > 0) state.sockets -= 1
    if (this.#total > 0) this.#total -= 1
    if (state.sockets === 0 && state.bucket >= CONNECT_RATE_PER_MIN) this.#byIp.delete(ip)
  }

  get total(): number {
    return this.#total
  }

  /** 帧上限。在 JSON.parse 之前看字节数，避免为一条超大帧白做一次解析。 */
  checkFrame(bytes: number): Admission {
    if (bytes > MAX_CONTROL_FRAME_BYTES) {
      return { ok: false, code: 413, reason: `frame exceeds ${String(MAX_CONTROL_FRAME_BYTES)} bytes` }
    }
    return { ok: true }
  }
}

/**
 * Origin 校验。
 *
 * WebSocket **不受 CORS 约束**：局域网里任何一个被访问的网页都能连
 * `ws://192.168.x.x:7443/dshlink` 并尝试配对。浏览器一定会带 Origin，
 * 非浏览器客户端不带——所以这里只拒绝"带了 Origin 但不在白名单"的请求，
 * 不要求必须带（否则 curl / App 原生连接会被误伤）。
 */
export function checkOrigin(
  origin: string | undefined,
  allowed: readonly string[],
  requestHost: string | undefined,
): boolean {
  if (origin === undefined || origin === '') return true

  // 同源：Origin 的 host:port 与请求的 Host 一致就是 dsh 自己的页面
  if (requestHost !== undefined && requestHost !== '') {
    try {
      const parsed = new URL(origin)
      if (parsed.host === requestHost) return true
    } catch {
      return false
    }
  }

  const normalized = origin.replace(/\/$/, '')
  return allowed.some((entry) => entry.replace(/\/$/, '') === normalized)
}

/** 由配置与请求推导白名单。回环来源永远允许。 */
export function defaultAllowedOrigins(): string[] {
  return [
    'http://127.0.0.1',
    'http://localhost',
    'https://127.0.0.1',
    'https://localhost',
  ]
}
