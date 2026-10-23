<script setup lang="ts">
/**
 * 冷启动动画：550W（红，待机）→ 180° 反转 → MOSS（青绿，就绪）。
 *
 * 视觉分四层，从后到前：
 *   1. 透视网格地面（CSS 3D，缓慢漂移营造"在前进"）
 *   2. CRT 质感：扫描线 + 暗角 + 噪点
 *   3. HUD 边角读数（仪表感：让画面像一台设备，而不是一张海报）
 *   4. 内容：终端日志 → 徽标环（刻度 + 进度环）→ 品牌揭示
 *
 * 一条纪律：**全部是 CSS 与几行 DOM，不引图片、不引 3D 引擎。**
 * 启动页是冷启动必经的一帧，首帧时间与体积优先；机体图已移到角标
 * （那里它是状态指示器，有功能价值）。
 *
 * 节奏 4.3s，但任意位置点击立即跳过——"仪式感"不能变成"每次都得等"。
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

type Phase = 'boot' | 'emblem' | 'flip' | 'reveal' | 'out' | 'gone'
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
  'CORE HANDSHAKE ..... OK',
  'TRANSPORT READY',
  'AWAITING HOST',
]

/** 环上的刻度数。纯 CSS 画，24 根刚好不显拥挤。 */
const TICKS = 24

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
  setTimeout(finish, 260)
}

onMounted(() => {
  if (props.quick) {
    at(120, () => (visible.value = 4))
    at(600, skip)
    return
  }
  // 0.6–1.5  逐行打字（每行 320ms，够读一个短句）
  // 2.2      徽标环出现
  // 2.9      反转（550W → MOSS）
  // 3.3      品牌揭示
  // 3.9      淡出
  // 4.3      完成
  for (let i = 1; i <= 4; i++) at(260 + i * 320, () => (visible.value = i))
  at(2200, () => (phase.value = 'emblem'))
  at(2900, () => (phase.value = 'flip'))
  at(3300, () => (phase.value = 'reveal'))
  at(3900, () => (phase.value = 'out'))
  at(4300, finish)
})

onBeforeUnmount(() => {
  for (const t of timers) clearTimeout(t)
})
</script>

<template>
  <view v-if="phase !== 'gone'" class="boot" :data-phase="phase" @tap="skip">
    <!-- 层 1：透视网格地面。绕 X 轴转到接近平视，横线才会"往远处收" -->
    <view class="grid-floor">
      <view v-for="i in 24" :key="'g' + i" class="grid-line" :style="{ top: i * 4 + '%' }" />
    </view>
    <view class="grid-side">
      <view v-for="i in 14" :key="'v' + i" class="grid-v" :style="{ left: i * 7 + '%' }" />
    </view>

    <!-- 层 2：CRT 质感 -->
    <view class="scanlines" />
    <view class="vignette" />
    <view class="noise" />
    <view class="glow" />

    <!-- 层 3：HUD 边角。纯装饰，但它们让画面像一台设备而不是一张海报 -->
    <view class="hud hud-tl">
      <text class="hud-k mono">SYS</text>
      <text class="hud-v mono">MOSS-LINK</text>
    </view>
    <view class="hud hud-tr">
      <text class="hud-k mono">MODE</text>
      <text class="hud-v mono">COLD BOOT</text>
    </view>
    <view class="hud hud-bl">
      <text class="hud-k mono">LINK</text>
      <text class="hud-v mono">STANDBY</text>
    </view>
    <view class="hud hud-br">
      <text class="hud-k mono">v0.1.0</text>
    </view>

    <!-- 层 4：内容 -->
    <view class="stage">
      <view class="term boot-term">
        <view class="term-bar">
          <view class="dot" />
          <text class="name mono">CORE TERMINAL</text>
          <text class="tag mono">550W</text>
        </view>
        <view class="term-body">
          <view v-for="(l, i) in lines()" :key="l" class="line mono" :class="{ show: i < visible }">
            <text class="pr">&gt;</text>
            <text class="lt">{{ l }}</text>
          </view>
          <view v-if="visible > 0 && visible < 4" class="line mono"><text class="cursor" /></view>
        </view>
      </view>

      <view class="emblem-wrap">
        <view class="ring-outer" />
        <view class="ring-progress" />
        <view class="ticks">
          <view
            v-for="i in TICKS"
            :key="'t' + i"
            class="tick"
            :style="{ transform: `rotate(${i * (360 / TICKS)}deg) translateY(-58px)` }"
          />
        </view>
        <view class="core">
          <text class="mark mono">MOSS</text>
        </view>
      </view>

      <view class="brand">
        <text class="brand-main mono">MOSS<text class="brand-acc">LINK</text></text>
        <text class="brand-sub mono">REMOTE BRIDGE · READY</text>
      </view>
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
  background: radial-gradient(ellipse 80% 60% at 50% 42%, #1a0c08 0%, #0a0504 46%, #020202 100%);
  overflow: hidden;
  transition: opacity 240ms ease;
}

.boot[data-phase='out'],
.boot[data-phase='gone'] {
  opacity: 0;
  pointer-events: none;
}

/* ── 层 1：透视网格 ─────────────────────────────────────────────────── */

.grid-floor {
  position: absolute;
  left: -25%;
  right: -25%;
  bottom: -12%;
  height: 62%;
  transform: perspective(520px) rotateX(74deg);
  transform-origin: 50% 100%;
  opacity: 0.5;
  animation: grid-drift 5.5s linear infinite;
}

.grid-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 70, 45, 0.42), transparent);
}

.grid-side {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 46%;
  transform: perspective(520px) rotateX(74deg);
  transform-origin: 50% 100%;
  opacity: 0.3;
}

.grid-v {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(255, 70, 45, 0.3), transparent);
}

@keyframes grid-drift {
  0% { transform: perspective(520px) rotateX(74deg) translateY(0); }
  100% { transform: perspective(520px) rotateX(74deg) translateY(4%); }
}

/* ── 层 2：CRT 质感 ─────────────────────────────────────────────────── */

.scanlines {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    0deg,
    rgba(255, 255, 255, 0.028) 0 1px,
    transparent 1px 3px
  );
  mix-blend-mode: screen;
}

.vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(circle at 50% 46%, transparent 34%, rgba(0, 0, 0, 0.72) 100%);
}

.noise {
  position: absolute;
  inset: -50%;
  pointer-events: none;
  opacity: 0.055;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
  animation: noise-shift 260ms steps(4) infinite;
}

@keyframes noise-shift {
  0% { transform: translate(0, 0); }
  25% { transform: translate(-3%, 2%); }
  50% { transform: translate(2%, -3%); }
  75% { transform: translate(-2%, -2%); }
  100% { transform: translate(3%, 1%); }
}

.glow {
  position: absolute;
  inset: -10%;
  background: radial-gradient(circle at 50% 50%, rgba(255, 59, 47, 0.16), transparent 56%);
  opacity: 0;
  transition: opacity 900ms ease, background 700ms ease;
}

.boot[data-phase='emblem'] .glow { opacity: 1; }

.boot[data-phase='flip'] .glow,
.boot[data-phase='reveal'] .glow {
  opacity: 1;
  background: radial-gradient(circle at 50% 50%, rgba(70, 227, 166, 0.2), transparent 58%);
}

/* ── 层 3：HUD 边角 ─────────────────────────────────────────────────── */

.hud {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 2px;
  opacity: 0;
  transition: opacity 500ms ease 400ms;
}

.boot:not([data-phase='out']) .hud { opacity: 0.62; }

.hud-tl { top: 18px; left: 18px; }
.hud-tr { top: 18px; right: 18px; align-items: flex-end; }
.hud-bl { bottom: 18px; left: 18px; }
.hud-br { bottom: 18px; right: 18px; align-items: flex-end; }

.hud-k {
  font-size: 9px;
  letter-spacing: 0.16em;
  color: rgba(255, 90, 70, 0.78);
}

.hud-v {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: rgba(255, 200, 190, 0.5);
}

.boot[data-phase='flip'] .hud-k,
.boot[data-phase='reveal'] .hud-k { color: rgba(70, 227, 166, 0.85); }

.boot[data-phase='flip'] .hud-v,
.boot[data-phase='reveal'] .hud-v { color: rgba(180, 240, 220, 0.6); }

/* ── 层 4：内容 ─────────────────────────────────────────────────────── */

.stage {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
}

.boot-term {
  position: absolute;
  width: 78%;
  max-width: 400px;
  transition:
    opacity 320ms ease,
    transform 460ms cubic-bezier(0.4, 0, 0.2, 1),
    filter 320ms ease;
}

.boot[data-phase='emblem'] .boot-term,
.boot[data-phase='flip'] .boot-term,
.boot[data-phase='reveal'] .boot-term,
.boot[data-phase='out'] .boot-term {
  opacity: 0;
  transform: translateY(-22px) scale(0.95);
  filter: blur(4px);
}

.line {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 20px;
  color: rgba(255, 190, 180, 0.84);
  opacity: 0;
  transform: translateY(5px);
  transition: opacity 240ms ease, transform 240ms ease;
}

.line.show {
  opacity: 1;
  transform: none;
}

.pr { color: rgba(255, 59, 47, 0.95); }

/* 等宽字体 + 一点点疏排 = 仪表读数的感觉 */
.lt { letter-spacing: 0.04em; }

.cursor {
  display: inline-block;
  width: 7px;
  height: 13px;
  background: rgba(255, 90, 70, 0.9);
  animation: blink 900ms steps(2) infinite;
}

@keyframes blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}

.emblem-wrap {
  position: absolute;
  width: 168px;
  height: 168px;
  display: grid;
  place-items: center;
  opacity: 0;
  transform: scale(0.82);
  transition: opacity 380ms ease, transform 520ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.boot[data-phase='emblem'] .emblem-wrap,
.boot[data-phase='flip'] .emblem-wrap,
.boot[data-phase='reveal'] .emblem-wrap,
.boot[data-phase='out'] .emblem-wrap {
  opacity: 1;
  transform: scale(1);
}

.ring-outer {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid rgba(255, 59, 47, 0.42);
  transition: border-color 600ms ease, box-shadow 600ms ease;
}

/* 扫描环：用 border 单边着色 + 旋转，比 conic-gradient 动画省性能 */
.ring-progress {
  position: absolute;
  inset: 10px;
  border-radius: 50%;
  border: 2px solid transparent;
  border-top-color: rgba(255, 90, 70, 0.95);
  border-right-color: rgba(255, 90, 70, 0.35);
  animation: spin 1.1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.ticks {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}

.tick {
  position: absolute;
  width: 1px;
  height: 7px;
  background: rgba(255, 90, 70, 0.45);
  transform-origin: 50% 58px;
}

.core {
  position: relative;
  width: 92px;
  height: 92px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: radial-gradient(circle, rgba(40, 10, 8, 0.9), rgba(8, 4, 4, 0.95));
  border: 1px solid rgba(255, 59, 47, 0.3);
  box-shadow: inset 0 0 22px rgba(255, 59, 47, 0.16);
  transition: border-color 600ms ease, box-shadow 600ms ease;
}

.mark {
  font-size: 17px;
  letter-spacing: 3px;
  color: #ffb3a8;
  transition: color 600ms ease;
}

/* 反转：整块 180°，红 → 绿 */
.boot[data-phase='flip'] .emblem-wrap {
  transform: rotateY(180deg) scale(1);
  transition: transform 460ms cubic-bezier(0.4, 0, 0.2, 1);
}

.boot[data-phase='flip'] .ring-outer,
.boot[data-phase='reveal'] .ring-outer {
  border-color: rgba(70, 227, 166, 0.72);
  box-shadow: 0 0 26px rgba(70, 227, 166, 0.28);
}

.boot[data-phase='flip'] .ring-progress,
.boot[data-phase='reveal'] .ring-progress {
  border-top-color: rgba(70, 227, 166, 0.95);
  border-right-color: rgba(70, 227, 166, 0.35);
}

.boot[data-phase='flip'] .tick,
.boot[data-phase='reveal'] .tick {
  background: rgba(70, 227, 166, 0.5);
}

.boot[data-phase='flip'] .core,
.boot[data-phase='reveal'] .core {
  border-color: rgba(70, 227, 166, 0.45);
  box-shadow:
    inset 0 0 22px rgba(70, 227, 166, 0.18),
    0 0 30px rgba(70, 227, 166, 0.14);
}

/* 反转后文字要"翻回来"，否则是镜像的 */
.boot[data-phase='flip'] .mark,
.boot[data-phase='reveal'] .mark {
  transform: rotateY(180deg);
  color: #9df0cd;
}

/* 品牌揭示：环缩到上方，文字在下方出现 */
.boot[data-phase='reveal'] .emblem-wrap {
  transform: scale(0.62) translateY(-34px);
  transition: transform 520ms cubic-bezier(0.4, 0, 0.2, 1);
}

.brand {
  position: absolute;
  bottom: 30%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 420ms ease, transform 420ms cubic-bezier(0.4, 0, 0.2, 1);
}

.boot[data-phase='reveal'] .brand,
.boot[data-phase='out'] .brand {
  opacity: 1;
  transform: none;
}

.brand-main {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 6px;
  color: #e6f3ec;
}

.brand-acc { color: #46e3a6; }

.brand-sub {
  font-size: 9.5px;
  letter-spacing: 0.22em;
  color: rgba(150, 200, 185, 0.62);
}

/* 减少动效偏好：关掉网格漂移、噪点、旋转环、光标闪烁 */
@media (prefers-reduced-motion: reduce) {
  .grid-floor,
  .noise,
  .ring-progress,
  .cursor {
    animation: none !important;
  }
}
</style>
