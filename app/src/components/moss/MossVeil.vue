<script setup lang="ts">
/**
 * 材质层：扫描线 + 暗角 + 噪点。
 *
 * 只挂一层（每页一个），pointer-events:none。
 * 浅色模式下 opacity 由 --veil-opacity 归零——亮底上的"光"只会变成脏污。
 */
</script>

<template>
  <view class="veil" />
  <view class="grain" />
</template>
