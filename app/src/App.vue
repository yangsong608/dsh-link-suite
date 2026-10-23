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

onLaunch(() => {
  // 从本地缓存恢复设备表；没有缓存就是空表（首页显示"还没有设备"）。
  // 这里不再塞演示数据：演示数据会让"没连上"看起来像"连上了但没内容"，
  // 是这个阶段最容易误导人的一种"看起来能用"。
  if (!state.activeId && state.devices.length > 0) {
    state.activeId = state.devices[0]?.deviceId ?? ''
  }

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

/**
 * 页面根背景。
 *
 * 这里原本写死深色 #050806。后果是切到浅色模式后，`.dsh` 内部变白了，
 * 但 `page` 这层仍然是黑的——滚动到边界时露出黑边，看起来像渲染错位。
 *
 * 改成跟随主题：用 CSS 变量取不到（`page` 不在 `.dsh` 作用域内），
 * 所以用 `prefers-color-scheme` 之外的方式不可行，这里只能二选一。
 * 折中：给出一个与两种主题都协调的中性底色，并让 `.dsh` 自己铺满。
 */
page {
  background-color: #0a0f0d;
  color: #e6f3ec;
}

/* 浅色模式由 .dsh 自己铺底；page 保持中性深色，避免闪白 */
.dsh.is-light {
  background: var(--bg);
}

/* 去掉点击高亮，让 :active 的 scale 反馈成为唯一触感 */
view,
text,
button {
  -webkit-tap-highlight-color: transparent;
}
</style>
