/**
 * 解锁票据：HMAC 签名的短期凭证。
 *
 * 为什么不用"客户端存一个 1"（moss 的做法）：那东西一改就开。
 * 票据由宿主签发、宿主校验，客户端只能持有而不能伪造。
 *
 * 作用域：`deviceId`。一台设备拿到票据后，别的设备不能用——这是"手机丢了只踢那一台"的基础。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface TicketPayload {
  readonly v: 1
  /** 谁的票据：'owner' 表示本机浏览器，或设备 id */
  readonly sub: string
  /** 签发时间 */
  readonly iat: number
  /** 过期时间 */
  readonly exp: number
  /** 随机串，防同秒同 sub 撞出相同票据 */
  readonly jti: string
}

const b64u = (buf: Buffer): string => buf.toString('base64url')
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url')

export function issueTicket(secret: Buffer, sub: string, ttlMs: number): string {
  const now = Date.now()
  const payload: TicketPayload = {
    v: 1,
    sub,
    iat: now,
    exp: now + ttlMs,
    jti: b64u(randomBytes(8)),
  }
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = b64u(createHmac('sha256', secret).update(body).digest())
  return `${body}.${sig}`
}

/** 校验失败一律返回 undefined，不区分"签名错"和"过期"——对攻击者少给信息。 */
export function verifyTicket(secret: Buffer, ticket: string, expectSub?: string): TicketPayload | undefined {
  const dot = ticket.indexOf('.')
  if (dot <= 0 || dot === ticket.length - 1) return undefined
  const body = ticket.slice(0, dot)
  const sig = ticket.slice(dot + 1)

  const expected = createHmac('sha256', secret).update(body).digest()
  let actual: Buffer
  try {
    actual = fromB64u(sig)
  } catch {
    return undefined
  }
  if (actual.byteLength !== expected.byteLength) return undefined
  if (!timingSafeEqual(actual, expected)) return undefined

  let payload: TicketPayload
  try {
    payload = JSON.parse(fromB64u(body).toString('utf8')) as TicketPayload
  } catch {
    return undefined
  }
  if (payload.v !== 1) return undefined
  if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return undefined
  if (expectSub !== undefined && payload.sub !== expectSub) return undefined
  return payload
}

/** 票据密钥：进程级随机，重启即失效。想让"重启后仍解锁"就得持久化，但那等于降低安全性，不做。 */
export function createSecret(): Buffer {
  return randomBytes(32)
}
