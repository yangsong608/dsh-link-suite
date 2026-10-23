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

const tabs = [
  { key: 'devices', label: '设备', icon: 'M3 5h18v11H3z M8 20h8M12 16v4' },
  { key: 'sessions', label: '会话', icon: 'M21 12a8 8 0 0 1-8 8H7l-4 3 1.2-4.2A8 8 0 1 1 21 12Z' },
  { key: 'me', label: '我的', icon: 'M12 11a3.4 3.4 0 1 0 0-6.8A3.4 3.4 0 0 0 12 11Z M4.5 20a7.5 7.5 0 0 1 15 0' },
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
    <slot />

    <view v-if="!hideTab" class="tabbar safe-bottom">
      <view
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ on: props.active === t.key }"
        @tap="go(t.key)"
      >
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
             stroke-linecap="round" stroke-linejoin="round">
          <path :d="t.icon" />
        </svg>
        <text class="lb">{{ t.label }}</text>
        <text v-if="t.key === 'sessions' && state.waiting > 0" class="badge mono">{{ state.waiting }}</text>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  padding-top: 8px;
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

.tab .ic {
  width: 21px;
  height: 21px;
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
