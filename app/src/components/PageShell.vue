<script setup lang="ts">
/**
 * 页面外壳：根节点、材质层、底部导航。
 *
 * 为什么把 veil/grain 放在这里而不是全局 App.vue：
 * uni-app 的 App.vue 不渲染模板（H5 除外），全局层只能挂在页面根上。
 * 一处定义、每页复用，避免"某个页面忘了加扫描线"。
 */
import { computed } from 'vue'
import { skinClass, themeClass, liteClass, state } from '@/core/store'
import { haptic } from '@/core/haptic'
import MossVeil from './moss/MossVeil.vue'

const props = defineProps<{
  active: 'devices' | 'sessions' | 'me'
  /** 详情页/对话页隐藏底部导航，把空间还给内容 */
  hideTab?: boolean
}>()

const emit = defineEmits<{ (e: 'tab', tab: 'devices' | 'sessions' | 'me'): void }>()

const rootClass = computed(() => ['dsh', skinClass.value, themeClass.value, liteClass.value])

/**
 * 图标一律用 CSS 画，不用内联 SVG。
 *
 * uni-app 的 App 端对内联 SVG 支持不稳定（这块踩过两次：对话页返回箭头
 * 渲染成空白、扫码按钮图标消失）。底部导航是全局入口，缺图标最伤。
 */
const tabs = [
  { key: 'devices', label: '设备' },
  { key: 'sessions', label: '会话' },
  { key: 'me', label: '我的' },
] as const

function go(key: 'devices' | 'sessions' | 'me'): void {
  if (key === props.active) return
  haptic('light')
  emit('tab', key)
}
</script>

<template>
  <view :class="rootClass">
    <MossVeil />
    <!-- 平板上内容限宽居中：一行太长会读不出来 -->
    <view class="page-wrap" :class="{ 'has-tab': !props.hideTab }"><slot /></view>

    <view v-if="!hideTab" class="tabbar safe-bottom">
      <view
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ on: props.active === t.key }"
        @tap="go(t.key)"
      >
        <view class="ic" :class="`ic-${t.key}`">
          <view class="ic-part a" />
          <view class="ic-part b" />
          <view class="ic-part c" />
        </view>
        <text class="lb">{{ t.label }}</text>
        <text v-if="t.key === 'sessions' && state.waiting > 0" class="badge mono">{{ state.waiting }}</text>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
/*
 * 内容包裹层。
 * 手机：占满宽度（--content-max: none）。
 * 平板：限宽并居中，两侧留白随断点放大。
 * 用 min-height 而不是 height：详情页内容可能比屏幕高。
 */
.page-wrap {
  width: 100%;
  max-width: var(--content-max);
  margin: 0 auto;
  min-height: 100%;
}

/*
 * 底部导航是 fixed 的，内容会滑到它下面。
 * 不给底部留白的话，最后一段（"关于"）永远看不全——
 * 这不是"要滚一下"，是滚到头也还是一半在导航下面。
 * 46 = tab 高度，8 = 上下内边距，再加安全区。
 */
.page-wrap.has-tab {
  padding-bottom: calc(46px + 12px + var(--safe-bottom-real, 0px));
}
/**
 * 底部导航。
 *
 * 这里原本写 `class="tabbar safe-bottom"`，但 safe-bottom 定义在全局
 * moss.scss 里——scoped 样式给本组件的类加 data-v 属性，而全局规则没有
 * 那个属性，选择器匹配不上。表现是底部导航紧贴屏幕下沿，全面屏手势条
 * 压住了 tab 文字。所以安全区必须写在本组件的 scoped 样式里。
 */
.tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  padding-top: 8px;
  /* --safe-bottom-real 由 moss.scss 的 .dsh 定义（含 Android 兜底值） */
  padding-bottom: calc(var(--safe-bottom-real, env(safe-area-inset-bottom)) + 2px);
  background: linear-gradient(180deg, transparent, var(--bg) 42%);
  border-top: 1px solid var(--bd);
}

.tab {
  flex: 1;
  height: 46px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: var(--t3);
  position: relative;
  transition: color var(--t-fast) var(--ease-out);
}

.tab.on { color: var(--acc); }

/* 选中态：颜色 + 顶部短线。只靠颜色在小屏上不够明确 */
.tab.on::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 18px;
  height: 2px;
  margin-left: -9px;
  border-radius: 0 0 2px 2px;
  background: var(--acc);
  box-shadow: 0 0 8px var(--acc-glow);
}

.tab .ic {
  position: relative;
  width: 21px;
  height: 21px;
}

/* 设备：显示器轮廓（方框 + 底座） */
.ic-devices .a {
  position: absolute;
  left: 1px; right: 1px; top: 2px; height: 13px;
  border: 1.7px solid currentColor;
  border-radius: 3px;
}
.ic-devices .b {
  position: absolute;
  left: 7px; right: 7px; top: 15px; height: 1.7px;
  background: currentColor;
}
.ic-devices .c {
  position: absolute;
  left: 4px; right: 4px; top: 17.5px; height: 1.7px;
  background: currentColor;
  border-radius: 1px;
}

/* 会话：对话气泡（圆角框 + 左下小尾巴） */
.ic-sessions .a {
  position: absolute;
  left: 1px; right: 1px; top: 2px; height: 13px;
  border: 1.7px solid currentColor;
  border-radius: 6px;
}
.ic-sessions .b {
  position: absolute;
  left: 5px; top: 14px;
  width: 5px; height: 5px;
  border-left: 1.7px solid currentColor;
  border-bottom: 1.7px solid currentColor;
  transform: skewX(-18deg) rotate(-24deg);
  border-bottom-left-radius: 2px;
}

/* 我的：头 + 肩 */
.ic-me .a {
  position: absolute;
  left: 7px; top: 1px;
  width: 7px; height: 7px;
  border: 1.7px solid currentColor;
  border-radius: 50%;
}
.ic-me .b {
  position: absolute;
  left: 2.5px; right: 2.5px; top: 10px; height: 9px;
  border: 1.7px solid currentColor;
  border-bottom: 0;
  border-radius: 9px 9px 0 0;
}

.tab .lb {
  font-size: 10px;
  letter-spacing: 0.6px;
}

.tab .badge {
  position: absolute;
  top: 4px;
  right: calc(50% - 22px);
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--warn);
  color: #201800;
  font-size: 9px;
  line-height: 15px;
  text-align: center;
  font-weight: 700;
}
</style>
