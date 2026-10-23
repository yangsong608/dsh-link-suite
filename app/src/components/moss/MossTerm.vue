<script setup lang="ts">
/**
 * 终端卡：本产品的原子组件。
 *
 * 所有"需要被当作一台机器看待"的内容都用它：设备卡、安装日志、锁屏框。
 * 圆角 10px（比普通卡片的 14px 更硬）——它像设备，不像卡片。
 */
import { computed } from 'vue'
import MossDot from './MossDot.vue'

const props = defineProps<{
  title: string
  /** 右上角标签：延迟、版本、"LOCKED" */
  tag?: string
  status?: 'online' | 'connecting' | 'offline' | 'needs-auth' | 'locked' | 'soft'
  /** 有条任务在跑：左侧 1px 竖条上下扫 */
  running?: boolean
  /** 锁定时把整张卡染成 550W 的语义（即使全局是 MOSS） */
  alert?: boolean
}>()

const tagText = computed(() => {
  if (props.tag !== undefined) return props.tag
  switch (props.status) {
    case 'locked':
      return 'LOCKED'
    case 'needs-auth':
      return 'NEED AUTH'
    case 'connecting':
      return 'LINKING'
    case 'offline':
      return 'OFFLINE'
    default:
      return ''
  }
})
</script>

<template>
  <view class="term" :class="{ 'term-alert': alert, 'term-off': status === 'offline' }">
    <view class="term-bar">
      <MossDot :status="status" />
      <text class="name">{{ title }}</text>
      <text v-if="tagText" class="tag mono">{{ tagText }}</text>
    </view>
    <view class="term-body">
      <slot />
    </view>
    <view v-if="running" class="running-bar" />
  </view>
</template>

<style lang="scss" scoped>
/* 锁定的机器用警戒色描边：一张卡就够，不要整页变红（docs/05 §2） */
.term-alert {
  border-color: var(--danger-bd);
  box-shadow:
    0 0 0 1px var(--danger-soft),
    0 12px 40px rgba(0, 0, 0, 0.45),
    inset 0 0 60px var(--danger-soft);
}

.term-alert .term-bar {
  background: linear-gradient(180deg, var(--danger-soft), transparent);
  color: var(--danger);
}

/**
 * 离线：把"荧光"整个抽掉。
 * 在线卡的内发光是这台机器"还亮着"的表达，离线的机器不该继续发光——
 * 否则一排暗卡里那点绿光会让用户误判它还连着（docs/05 §1「光即状态」）。
 */
.term-off {
  border-color: var(--bd);
  background: var(--s1);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.32);
}

.term-off .term-bar {
  background: transparent;
}

.term-off .name {
  color: var(--t3);
}
</style>
