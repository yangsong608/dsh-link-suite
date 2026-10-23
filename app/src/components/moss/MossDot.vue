<script setup lang="ts">
/**
 * 状态点 / 连接中的三格波 / 离线空心圆。
 *
 * 形状必须能区分，不能只靠颜色：红绿色盲占男性 8%（docs/05 §8.4）。
 */
const props = defineProps<{
  status?: 'online' | 'connecting' | 'offline' | 'needs-auth' | 'locked' | 'soft'
}>()

const kind = (): 'dot' | 'wave' | 'off' => {
  switch (props.status) {
    case 'connecting':
      return 'wave'
    case 'offline':
      return 'off'
    default:
      return 'dot'
  }
}

const dotClass = (): string => {
  switch (props.status) {
    case 'online':
      return 'glow'
    case 'needs-auth':
    case 'soft':
      return 'warn'
    case 'locked':
      // 锁定走 danger 而不是 glow：MOSS 皮肤下 --acc 是绿，
      // 用 glow 会把"锁着"画成"在线"。
      return 'danger'
    default:
      return ''
  }
}
</script>

<template>
  <view v-if="kind() === 'wave'" class="wave"><i /><i /><i /></view>
  <view v-else-if="kind() === 'off'" class="dot off" />
  <view v-else class="dot" :class="dotClass()" />
</template>
