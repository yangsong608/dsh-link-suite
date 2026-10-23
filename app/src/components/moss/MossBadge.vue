<script setup lang="ts">
/**
 * MOSS 状态角标。
 *
 * 两个状态对应两张预渲染图（badge-idle / badge-work）：
 * 眼灯暗 = 待机，眼灯亮 = 有任务在跑。
 *
 * 为什么用图而不是运行时 3D：
 *   Three.js 656KB + FBX 1MB 会突破 400KB 首包预算（docs/05 §8），
 *   而这个角标只有 28-56px，3D 的细节一点也看不出来。
 *   预渲染两张图合计 12KB，视觉上反而更锐利。
 *
 * 一个刻意的细节：切换状态时做一次极短的交叉淡入，而不是直接换图。
 * 直接换会有"闪一下"的廉价感；120ms 的过渡让它像灯在亮起来。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 是否有任务在跑。true 时眼灯亮。 */
    working?: boolean
    /** 尺寸（px）。默认 28，够放在标题右侧不抢注意力。 */
    size?: number
    /** 光晕强度：0 = 不发光（低端机/省电模式） */
    glow?: boolean
  }>(),
  { working: false, size: 28, glow: true },
)

const src = computed(() => (props.working ? '/static/moss/badge-work.webp' : '/static/moss/badge-idle.webp'))
const boxStyle = computed(() => ({
  width: `${String(props.size)}px`,
  height: `${String(props.size)}px`,
}))
</script>

<template>
  <view class="moss-badge" :class="{ working: props.working, 'no-glow': !props.glow }" :style="boxStyle">
    <!-- 底座：机器人本身是白色金属质感，小尺寸下直接放深色背景
         会变成"一团白"。给一层深色芯片底座 + 细描边，小图才立得住，
         也顺便让角标看起来像仪表盘上的一个状态灯。 -->
    <view class="plate" />
    <image class="img" :src="src" mode="aspectFit" />
  </view>
</template>

<style lang="scss" scoped>
.moss-badge {
  position: relative;
  display: grid;
  place-items: center;
  flex: none;
}

.plate {
  position: absolute;
  inset: 4%;
  border-radius: 50%;
  background:
    radial-gradient(circle at 38% 30%, var(--s3) 0%, var(--s1) 62%, var(--bg) 100%);
  border: 1px solid var(--bd);
  box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.06);
}

.img {
  position: relative;
  width: 92%;
  height: 92%;
  transition: opacity 120ms ease;
}

/* 工作时底座描边跟着变色：光晕之外再加一层静态提示，
   低端机（no-glow）关掉动画后仍能看出"在跑" */
.moss-badge.working .plate {
  border-color: rgba(255, 92, 77, 0.5);
  box-shadow: inset 0 0 8px rgba(255, 92, 77, 0.25);
}

/**
 * 工作时在背后加一圈红晕。
 *
 * 这一层是 CSS 而不是图里带的：图里的光晕在 28px 下会被缩没，
 * 用一个绝对定位的径向渐变可以在任何尺寸下保持可见，而且
 * 呼吸动画由 CSS 驱动，不需要多帧图片。
 */
.moss-badge.working::before {
  content: '';
  position: absolute;
  inset: -22%;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 59, 47, 0.4) 0%, rgba(255, 59, 47, 0.12) 45%, transparent 70%);
  animation: moss-breathe 2.4s ease-in-out infinite;
  pointer-events: none;
}

.moss-badge.working.no-glow::before {
  animation: none;
  opacity: 0.5;
}

@keyframes moss-breathe {
  0%, 100% { opacity: 0.55; transform: scale(0.94); }
  50% { opacity: 1; transform: scale(1.06); }
}

/* 减少动效偏好：只留静态光晕 */
@media (prefers-reduced-motion: reduce) {
  .moss-badge.working::before { animation: none; opacity: 0.7; }
}
</style>
