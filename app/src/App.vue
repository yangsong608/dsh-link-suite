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
  /*
   * 启动动画的"已播过"标记必须在**冷启动**时清掉。
   *
   * 之前这个标记是 index.vue 里的一个模块级变量。切 tab 用 reLaunch
   * 会重建页面，模块变量在同一次运行里本该保留——实际观测到的却是
   * 每次点「设备」都重播一遍。把标记落到 storage 并在这里重置，
   * 语义就明确成"每次冷启动播一次，进程内不再播"。
   */
  try { uni.removeStorageSync('dsh-link/booted') } catch { /* 存储不可用就每次播 */ }
  // 从本地缓存恢复设备表；没有缓存就是空表（首页显示"还没有设备"）。
  // 这里不再塞演示数据：演示数据会让"没连上"看起来像"连上了但没内容"，
  // 是这个阶段最容易误导人的一种"看起来能用"。
  if (!state.activeId && state.devices.length > 0) {
    state.activeId = state.devices[0]?.deviceId ?? ''
  }

  try {
    const info = uni.getSystemInfoSync()

    // ── 状态栏高度：真机实测，不靠 CSS 变量 ──────────────────────────────
    //
    // 之前用 `var(--status-bar-height)` 做兜底，真机上仍然是 0——uni-app 只在
    // 部分场景（nvue / 特定版本）注入这个变量，普通 Vue 页面拿不到。
    // 而 `env(safe-area-inset-top)` 在 App 端（尤其是 Android）也常为 0。
    //
    // 唯一可靠的是 getSystemInfoSync().statusBarHeight（单位 px）。拿到之后
    // 写进 CSS 变量，由 .safe-top 消费。setProperty 在 uni-app 的 App 端
    // 走 WebView，document 可用；H5 同样可用。
    try {
      // 两个来源，取第一个有效值：
      //   getWindowInfo()：HBuilderX 4.x+ 推荐，字段更精确
      //   getSystemInfoSync().statusBarHeight：老版本兜底
      // 都取不到时靠 CSS 的 max(..., 24px) 兜底。
      const win = (() => {
        try {
          const fn = (uni as unknown as { getWindowInfo?: () => { statusBarHeight?: number } }).getWindowInfo
          return typeof fn === 'function' ? fn() : undefined
        } catch {
          return undefined
        }
      })()
      const statusBar = win?.statusBarHeight
        ?? (info as unknown as { statusBarHeight?: number }).statusBarHeight
      if (typeof statusBar === 'number' && statusBar > 0) {
        // 额外留 6px 呼吸空间：紧贴状态栏下沿看起来像被切掉
        const px = `${String(Math.round(statusBar) + 6)}px`
        // 写到 documentElement 与 body 两处：uni-app 的 App 端页面挂在
        // 自定义根节点下，只写 documentElement 有时继承链会断在中间容器上。
        const doc = (globalThis as {
          document?: {
            documentElement: { style: { setProperty(k: string, v: string): void } }
            body?: { style: { setProperty(k: string, v: string): void } }
          }
        }).document
        doc?.documentElement.style.setProperty('--sb-top', px)
        doc?.body?.style.setProperty('--sb-top', px)
        // 同时写一份到内联样式，供非 CSS 变量的场景读取（如调试面板）
        ;(globalThis as { __DSH_LINK_STATUS_BAR__?: number }).__DSH_LINK_STATUS_BAR__ = statusBar
      }
    } catch {
      // 取不到就退回 CSS 的 max(...) 兜底链
    }

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
