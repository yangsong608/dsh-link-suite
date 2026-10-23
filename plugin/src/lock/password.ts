/**
 * 密码：scrypt + 服务端比对。
 *
 * 三条铁律（与 dsh-startup-moss 的门口令一致，因为那套已经验证过）：
 *   1. 浏览器/App 永远拿不到 salt 与 hash，因此无法离线爆破
 *   2. 比对用 timingSafeEqual，避免按字节早退泄漏信息
 *   3. 失败计数与限速在**服务端**，客户端的计数只是展示
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** N=16384 时单次约 60–80ms：够慢到抵抗爆破，够快到用户不觉得卡。 */
const DEFAULT_PARAMS = { N: 16_384, r: 8, p: 1, keylen: 32 } as const

export interface PasswordRecord {
  readonly algo: 'scrypt'
  readonly salt: string
  readonly hash: string
  readonly N: number
  readonly r: number
  readonly p: number
  readonly keylen: number
}

export function hashPassword(password: string): PasswordRecord {
  if (password.length < 6) throw new Error('password must be at least 6 characters')
  const salt = randomBytes(16)
  const { N, r, p, keylen } = DEFAULT_PARAMS
  const hash = scryptSync(password, salt, keylen, { N, r, p })
  return {
    algo: 'scrypt',
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    N,
    r,
    p,
    keylen,
  }
}

export function verifyPassword(record: PasswordRecord | undefined, password: string): boolean {
  if (record === undefined) return false
  if (record.algo !== 'scrypt') return false
  let expected: Buffer
  try {
    expected = Buffer.from(record.hash, 'base64')
  } catch {
    return false
  }
  const actual = scryptSync(password, Buffer.from(record.salt, 'base64'), record.keylen, {
    N: record.N,
    r: record.r,
    p: record.p,
  })
  if (actual.byteLength !== expected.byteLength) return false
  return timingSafeEqual(actual, expected)
}

/**
 * 尝试限速：窗口内最多 max 次，超限后给出 retryAfterMs。
 *
 * 用滑动窗口而不是固定桶：固定桶在窗口边界可以双倍尝试（第 5 分钟末 + 第 6 分钟初）。
 */
export class AttemptLimiter {
  readonly #max: number
  readonly #windowMs: number
  #failures: number[] = []

  constructor(max: number, windowMs: number) {
    this.#max = max
    this.#windowMs = windowMs
  }

  #prune(now: number): void {
    const from = now - this.#windowMs
    this.#failures = this.#failures.filter((t) => t > from)
  }

  get failures(): number {
    this.#prune(Date.now())
    return this.#failures.length
  }

  /** 还能试几次。0 表示已锁。 */
  get remaining(): number {
    return Math.max(0, this.#max - this.failures)
  }

  /** 还要等多久才能再试（毫秒）。0 表示现在就能试。 */
  get retryAfterMs(): number {
    const now = Date.now()
    this.#prune(now)
    const first = this.#failures[0]
    if (this.#failures.length < this.#max || first === undefined) return 0
    return Math.max(0, first + this.#windowMs - now)
  }

  recordFailure(): void {
    this.#failures.push(Date.now())
  }

  reset(): void {
    this.#failures = []
  }
}
