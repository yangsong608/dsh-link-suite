<script setup lang="ts">
/**
 * App 根。
 *
 * uni-app 的 App.vue 不渲染模板（H5 除外），所以这里只做两件事：
 *   1. 引入全局样式（tokens + moss 原子层）
 *   2. 冷启动时检测设备能力，决定是否降级视觉
 *
 * 页面外壳在 components/PageShell.vue——那里才有 veil / grain / tabbar。
 */
import { onLaunch } from '@dcloudio/uni-app'
import { state, prefs } from '@/core/store'
import { demoDevices } from '@/core/demo'

onLaunch(() => {
  // TODO(M1): 换成从本地设备表恢复再逐台重连；现在是演示数据。
  // 放在 App 而不是首页里，是为了冷启动直接落到「会话」页时列表也不是空的。
  if (state.devices.length === 0) state.devices = demoDevices()
  if (!state.activeId) state.activeId = state.devices[0]?.deviceId ?? ''

  try {
    const info = uni.getSystemInfoSync()

    // 跟随系统深浅色——但只在用户没手动选过的时候。
    // 否则设置里辛苦选的浅色，下次冷启动会被系统设置悄悄改掉。
    if (!prefs.lightStored) state.light = info.osTheme === 'light'

    // 低端机降级：关噪点与呼吸动画。阈值取 benchmarkLevel < 20，
    // 覆盖到骁龙 6 系以下；这是"能跑"与"好跑"的分界线（docs/05 §6）。
    const level = (info as unknown as { benchmarkLevel?: number }).benchmarkLevel
    if (typeof level === 'number' && level >= 0 && level < 20) state.lite = true
  } catch {
    // 取不到系统信息时按默认（深色 + 全效果）走
  }
})
</script>

<style lang="scss">
@import '@/styles/tokens.scss';
@import '@/styles/moss.scss';

page {
  background-color: #050806;
  color: #e6f3ec;
}

/* 去掉点击高亮，让 :active 的 scale 反馈成为唯一触感 */
view,
text,
button {
  -webkit-tap-highlight-color: transparent;
}
</style>
