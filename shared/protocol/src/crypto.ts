/**
 * 加密层的**可移植部分**：nonce 布局、计数器、密钥长度。
 *
 * 具体算法实现放在两侧（宿主用 node:crypto，App 用原生或纯 JS），
 * 因为 protocol 包必须零依赖、能在 uni-app 的 JS 引擎里跑。
 *
 * ── 关于算法的一点诚实说明 ─────────────────────────────────────────────
 * 技术方案 §4.4 写的是 XChaCha20-Poly1305。它的核心价值是 **24 字节 nonce 可以随机**
 * （不依赖计数器也不会撞）。但 Node 的 OpenSSL 只给 12 字节 nonce 的 ChaCha20-Poly1305，
 * 用 XChaCha 需要自己实现 HChaCha20 派生，等于自己造密码学。
 *
 * 本轮实现取等效做法：**4 字节随机前缀 + 8 字节计数器 = 12 字节 nonce**。
 * 前缀每次连接随机，计数器每帧递增——撞 nonce 的前提是"同一连接内计数器回绕"，
 * 而这在第 2^64 帧前不可能发生（1 小时强制 rekey）。
 *
 * 好处：调用方接口不变（seal/open 形状一致），后续若换成 XChaCha 只需替换实现。
 * 这个取舍要同步进技术文档，不要只活在注释里。
 */

/** 分组密钥长度（ChaCha20 / XChaCha20 均为 32 字节）。 */
export const KEY_BYTES = 32

/** Poly1305 认证标签长度。 */
export const TAG_BYTES = 16

/** nonce = 4B 随机前缀 + 8B 帧计数器。 */
export const NONCE_PREFIX_BYTES = 4
export const NONCE_COUNTER_BYTES = 8
export const NONCE_BYTES = NONCE_PREFIX_BYTES + NONCE_COUNTER_BYTES

/**
 * 构造 nonce。`counter` 用 bigint 是因为 2^53 之后 number 会丢精度，
 * 虽然实际到不了，但类型上不给自己留坑。
 */
export function buildNonce(prefix: Uint8Array, counter: bigint): Uint8Array {
  if (prefix.byteLength !== NONCE_PREFIX_BYTES) {
    throw new Error(`crypto: nonce prefix must be ${NONCE_PREFIX_BYTES} bytes`)
  }
  const nonce = new Uint8Array(NONCE_BYTES)
  nonce.set(prefix, 0)
  new DataView(nonce.buffer).setBigUint64(NONCE_PREFIX_BYTES, counter, false)
  return nonce
}

/** 加密器：宿主与 App 各自实现，形状必须一致，否则跨端联调会很难查。 */
export interface Aead {
  seal(plaintext: Uint8Array, aad?: Uint8Array): Uint8Array
  open(ciphertext: Uint8Array, aad?: Uint8Array): Uint8Array
  readonly counter: bigint
}

/** 每 N 帧或每 T 毫秒强制换钥（技术方案 §4.4：1 小时或 2^20 帧）。 */
export const REKEY_FRAMES = 2n ** 20n
export const REKEY_MS = 60 * 60 * 1000

export function shouldRekey(counter: bigint, connectedAt: number): boolean {
  return counter >= REKEY_FRAMES || Date.now() - connectedAt >= REKEY_MS
}

/** 常量时间比较，避免认证标签比对被计时侧信道利用。 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}
