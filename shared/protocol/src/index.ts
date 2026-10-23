/**
 * @dsh-link/protocol
 *
 * 宿主与 App 之间**唯一**的契约来源。改这里 = 改协议，两侧必须同时升级。
 * 版本不匹配时的行为：缺 `caps` 项即视为不支持，不允许"猜"。
 */

export * from './methods.js'
export * from './errors.js'
export * from './frame.js'
export * from './types.js'
export * from './crypto.js'
export * from './policy.js'
export * from './qr.js'
export * from './pairing.js'
