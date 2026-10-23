<script setup lang="ts">
/**
 * 冷启动动画：550W（红，待机）→ 反转 → MOSS（青绿，就绪）。
 *
 * 1.4s，任意位置点击立即跳过。四阶段与 dsh-startup-moss 同构：
 *   boot(0–500) → emblem(500–900) → flip(900–1200) → out(1200–1400)
 *
 * **为什么这么短**：moss 是"开机一次"的仪式，这个是"每天开二十次"的工具。
 * 仪式做一次是惊喜，做二十次是阻挠（docs/05 §0）。
 *
 * 首帧就是画好的静态文字，不等网络——设备状态在动画期间并行加载。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 热启动只播一小段的"眨眼" */
    quick?: boolean
  }>(),
  { quick: false },
)

const emit = defineEmits<{ (e: 'done'): void }>()

type Phase = 'boot' | 'emblem' | 'flip' | 'out' | 'gone'
const phase = ref<Phase>('boot')
const visible = ref(0)
const timers: ReturnType<typeof setTimeout>[] = []

/**
 * 启动日志。
 *
 * 刻意**不含任何设备信息**（主机数、主机名都不显示）：启动页是每次冷启动
 * 都会出现的公开画面，把"你连了几台机器、叫什么名字"印在上面，
 * 在别人面前打开 App 时是一种不必要的暴露。状态信息留给首页。
 */
const lines = (): string[] => [
  'MOSS LINK v0.1.0',
  'INITIALIZING',
  'LINK MODULE',
  'READY',
]

function at(ms: number, fn: () => void): void {
  timers.push(setTimeout(fn, ms))
}

function finish(): void {
  phase.value = 'gone'
  emit('done')
}

function skip(): void {
  if (phase.value === 'gone' || phase.value === 'out') return
  for (const t of timers) clearTimeout(t)
  timers.length = 0
  phase.value = 'out'
  setTimeout(finish, 200)
}

onMounted(() => {
  if (props.quick) {
    at(160, () => (visible.value = 4))
    at(700, skip)
    return
  }
  // 节奏说明：原来的 1400ms 全程太快——四行日志每 110ms 就刷完，
  // 眼睛还没读完就翻篇了，看起来像"闪了一下"。启动动画的作用是
  // 让等待有质感，不是抢时间，所以每一段都要留出可读的停顿。
  //
  //   0.0–1.5s  逐行打字（每行 240ms，够读一个单词）
  //   1.5–2.3s  停顿，让最后一行"READY"被看见
  //   2.3s      出徽标
  //   3.0s      翻转（徽标 → MOSS）
  //   3.8s      淡出
  //   4.2s      完成
  for (let i = 1; i <= 4; i++) at(180 + i * 240, () => (visible.value = i))
  at(1500, () => (phase.value = 'emblem'))
  at(2300, () => (phase.value = 'flip'))
  at(3000, () => (phase.value = 'out'))
  at(4200, finish)
})

onBeforeUnmount(() => {
  for (const t of timers) clearTimeout(t)
})
</script>

<template>
  <view v-if="phase !== 'gone'" class="boot" :data-phase="phase" @tap="skip">
    <view class="veil" />
    <view class="glow" />

    <view class="term boot-term">
      <view class="term-bar">
        <view class="dot" />
        <text class="name">CORE TERMINAL</text>
        <text class="tag mono">550W</text>
      </view>
      <view class="term-body">
        <view v-for="(l, i) in lines()" :key="l" class="line mono" :class="{ show: i < visible }">
          <text class="pr">&gt;</text>
          <text>{{ l }}</text>
        </view>
        <view v-if="visible > 0 && visible < 4" class="line mono"><text class="cursor" /></view>
      </view>
    </view>

    <!-- 启动页只留终端框与徽标环，不放 MOSS 机体图。
         机体图留给首页/会话页的角标（那里它是状态指示器，有意义）；
         启动页放一张大图既拖慢首屏，也在深色底上看不清细节。 -->
    <view class="emblem-wrap">
      <view class="ring" />
      <view class="mark mono">MOSS</view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.boot {
  position: fixed;
  inset: 0;
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(ellipse 90% 70% at 50% 38%, #160a07 0%, #0a0504 48%, #030202 100%);
  overflow: hidden;
  transition: opacity 220ms ease;
}

.boot[data-phase='out'],
.boot[data-phase='gone'] {
  opacity: 0;
  pointer-events: none;
}

.glow {
  position: absolute;
  inset: -10%;
  background: radial-gradient(circle at 50% 50%, rgba(255, 59, 47, 0.12), transparent 58%);
  opacity: 0;
  transition: opacity 1.2s ease;
}

.boot[data-phase='emblem'] .glow,
.boot[data-phase='flip'] .glow {
  opacity: 1;
}

/* 终端在 emblem 阶段退场：上移 + 微缩 + 模糊，而不是简单消失 */
.boot-term {
  position: absolute;
  width: 78%;
  max-width: 420px;
  transition:
    opacity 300ms ease,
    transform 420ms cubic-bezier(0.4, 0, 0.2, 1),
    filter 300ms ease;
}

.boot[data-phase='emblem'] .boot-term,
.boot[data-phase='flip'] .boot-term,
.boot[data-phase='out'] .boot-term {
  opacity: 0;
  transform: translateY(-18px) scale(0.96);
  filter: blur(3px);
}

.line {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 20px;
  color: rgba(255, 190, 180, 0.82);
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 220ms ease, transform 220ms ease;
}

.line.show {
  opacity: 1;
  transform: none;
}

.pr { color: rgba(255, 59, 47, 0.9); }

/* 徽标：0 → 出现；第 900ms 起 180° 反转（MOSS 的那一面） */
.emblem-wrap {
  position: relative;
  width: 92px;
  height: 92px;
  display: grid;
  place-items: center;
  opacity: 0;
  transform: scale(0.9);
  transition: opacity 300ms ease, transform 420ms cubic-bezier(0.4, 0, 0.2, 1);
}

.boot[data-phase='emblem'] .emblem-wrap,
.boot[data-phase='flip'] .emblem-wrap,
.boot[data-phase='out'] .emblem-wrap {
  opacity: 1;
  transform: scale(1);
}

.ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid rgba(70, 227, 166, 0.55);
  box-shadow: 0 0 18px rgba(70, 227, 166, 0.25), inset 0 0 24px rgba(70, 227, 166, 0.12);
}

.mark {
  font-size: 19px;
  letter-spacing: 2px;
  color: #9df0cd;
  transition: color 300ms ease;
}

/* 反转：整块 180°，颜色从红切到绿——这是"550W 变成 MOSS"的那一下 */
.boot[data-phase='flip'] .emblem-wrap {
  transform: rotateY(180deg) scale(1);
  transition: transform 300ms cubic-bezier(0.4, 0, 0.2, 1);
}

.boot[data-phase='flip'] .ring {
  border-color: rgba(70, 227, 166, 0.9);
  box-shadow: 0 0 28px rgba(70, 227, 166, 0.45);
}

.boot[data-phase='flip'] .mark {
  transform: rotateY(180deg);
}
</style>
