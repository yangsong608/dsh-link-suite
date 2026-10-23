<script setup lang="ts">
/**
 * 配对雷达。
 *
 * 用 CSS 而不是 Canvas：这是一层低频装饰动画，CSS 交给合成器，
 * 不占 JS 线程，也不多吃一个渲染上下文（docs/05 §5.3 的实现注记）。
 *
 * 一条硬规则：**扫不到设备时什么都不做**。不出现"未发现设备"的红字——
 * 它只让用户焦虑，且信息量为零（配对靠二维码，不靠发现）。
 */
withDefaults(
  defineProps<{
    /** 已发现的主机位置，0–100 的百分比 */
    points?: { x: number; y: number; label?: string }[]
  }>(),
  { points: () => [] },
)
</script>

<template>
  <view class="radar">
    <view class="ring r1" />
    <view class="ring r2" />
    <view class="ring r3" />
    <view class="sweep" />
    <view
      v-for="(p, i) in points"
      :key="i"
      class="blip"
      :style="{ left: `${p.x}%`, top: `${p.y}%` }"
    >
      <view class="blip-core" />
      <text v-if="p.label" class="blip-lb mono">{{ p.label }}</text>
    </view>
    <view class="center" />
  </view>
</template>

<style lang="scss" scoped>
.radar {
  position: relative;
  width: 240px;
  height: 240px;
  margin: 0 auto;
  border-radius: 50%;
  overflow: hidden;
}

.ring {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  border: 1px solid var(--bd);
}

.r1 { width: 78px; height: 78px; }
.r2 { width: 150px; height: 150px; }
.r3 { width: 222px; height: 222px; }

/* 30° 扇形扫光：从 0° 顺时针 3s 一圈 */
.sweep {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    var(--acc-soft) 0deg,
    var(--acc-soft) 12deg,
    transparent 42deg,
    transparent 360deg
  );
  animation: spin 3s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.dsh.is-lite .sweep,
.dsh.is-light .sweep {
  animation-duration: 6s;
}

.center {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  background: var(--acc);
  box-shadow: 0 0 10px var(--acc-glow);
}

.blip {
  position: absolute;
  transform: translate(-50%, -50%);
}

.blip-core {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--acc);
  box-shadow: 0 0 12px var(--acc-glow);
  animation: pulse 1.6s ease-out infinite;
}

@keyframes pulse {
  0% { transform: scale(0.6); opacity: 0.6; }
  40% { transform: scale(1.6); opacity: 1; }
  100% { transform: scale(1); opacity: 0.9; }
}

.blip-lb {
  position: absolute;
  left: 14px;
  top: -6px;
  font-size: 10px;
  color: var(--t2);
  white-space: nowrap;
}
</style>
