/**
 * 触感：与动效成对设计。
 *
 * 规则（docs/05 §4.4）：
 *   - 切页/完成 = light
 *   - 发送/解锁成功 = medium
 *   - 批准/失败 = heavy
 *   - **离线不震动**：震动代表"有事找你"，设备离线不是事，是常态
 */

export type HapticKind = 'light' | 'medium' | 'heavy'

export function haptic(kind: HapticKind): void {
  try {
    // App 端支持 type；H5/小程序会静默失败，不该因此报错
    uni.vibrateShort({ type: kind, fail: () => {} })
  } catch {
    /* 忽略 */
  }
}

/** 解锁成功：两下轻震，间隔 80ms——像机械锁芯弹开两格 */
export function hapticUnlock(): void {
  haptic('light')
  setTimeout(() => haptic('light'), 80)
}
