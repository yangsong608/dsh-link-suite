<script setup lang="ts">
/**
 * 首页：设备列表。
 *
 * 信息架构的第一条决定：**首页不该是聊天，应该是"谁在等我"**。
 * 手机上打字体验注定不如电脑，但审批只要两次点击——
 * 所以最上面永远是"等你的事"，设备列表在其次（docs/03 §5）。
 */
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import PageShell from '@/components/PageShell.vue'
import MossTerm from '@/components/moss/MossTerm.vue'
import MossBoot from '@/components/moss/MossBoot.vue'
import { state, activeDevice, skinClass, themeClass, liteClass, type DeviceCard } from '@/core/store'
import { demoDevices } from '@/core/demo'
import { haptic } from '@/core/haptic'

const booting = ref(true)
const refreshing = ref(false)

const onlineCount = computed(() => state.devices.filter((d) => d.conn === 'online').length)
const lockedDevices = computed(() => state.devices.filter((d) => d.lock?.locked === true))
const needAuth = computed(() => state.devices.filter((d) => d.conn === 'needs-auth'))

/**
 * "我的电脑"里剔除已经出现在"需要你"里的机器。
 * 一台锁着的机器如果上下各出现一次，用户会以为自己配了两台机器，
 * 而且在 844px 的屏幕上白白吃掉一次滚动。谁需要你，谁就只在该出现的地方出现。
 */
const otherDevices = computed(() =>
  state.devices.filter((d) => d.lock?.locked !== true && d.conn !== 'needs-auth'),
)

const rootClass = computed(() => ['dsh', skinClass.value, themeClass.value, liteClass.value])

function statusOf(d: DeviceCard): 'online' | 'connecting' | 'offline' | 'needs-auth' | 'locked' {
  if (d.conn === 'offline') return 'offline'
  if (d.conn === 'needs-auth') return 'needs-auth'
  if (d.conn === 'connecting') return 'connecting'
  if (d.lock?.locked) return 'locked'
  return 'online'
}

function metaLine(d: DeviceCard): string {
  if (d.conn === 'offline') return '上次在线 3 小时前'
  const bits: string[] = []
  if (d.host?.platform) bits.push(d.host.platform)
  if (d.endpointKind) {
    bits.push(d.endpointKind === 'lan' ? '局域网' : d.endpointKind === 'relay' ? '中继' : 'Tailscale')
  }
  if (d.latencyMs !== undefined) bits.push(`${d.latencyMs}ms`)
  return bits.join(' · ')
}

function usageLine(d: DeviceCard): string {
  if (d.lock?.locked) return '已锁定 · 任务仍在后台继续'
  const parts: string[] = []
  if (d.sessionCount !== undefined) parts.push(`${d.sessionCount} 个会话`)
  if (d.runningCount !== undefined && d.runningCount > 0) parts.push(`${d.runningCount} 个运行中`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

function open(d: DeviceCard): void {
  haptic('light')
  state.activeId = d.deviceId
  if (d.lock?.locked) {
    state.lockDialogFor = d.deviceId
    return
  }
  uni.navigateTo({ url: '/pages/sessions/sessions' })
}

function requestUnlock(): void {
  haptic('medium')
  state.lockDialogFor = ''
  uni.showToast({ title: '已向电脑发送解锁请求', icon: 'none' })
}

function dismiss(): void {
  state.lockDialogFor = ''
}

async function refresh(): Promise<void> {
  refreshing.value = true
  haptic('light')
  // TODO(M1): 换成 Link.call('device.list')
  await new Promise((r) => setTimeout(r, 600))
  refreshing.value = false
}

function addDevice(): void {
  haptic('medium')
  uni.showToast({ title: '配对：扫码 → 比对 6 位指纹 → 输密码', icon: 'none' })
}

function goTab(tab: 'devices' | 'sessions' | 'me'): void {
  const map = { devices: '/pages/index/index', sessions: '/pages/sessions/sessions', me: '/pages/me/me' }
  uni.reLaunch({ url: map[tab] })
}

onLoad(() => {
  // TODO(M1): 从本地缓存 + Link 拉取；现在是演示数据
  if (state.devices.length === 0) state.devices = demoDevices()
  state.activeId = state.activeId || state.devices[0]?.deviceId || ''
})
</script>

<template>
  <PageShell active="devices" @tab="goTab">
    <MossBoot
      v-if="booting"
      :host-count="onlineCount"
      :last-name="activeDevice?.name ?? ''"
      @done="booting = false"
    />

    <view class="head safe-top">
      <view class="brand">
        <text class="logo mono">DSH<text class="logo-acc">LINK</text></text>
        <text class="ver mono">v0.1.0</text>
      </view>
      <view class="actions">
        <view class="iconbtn" @tap="refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
            <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 12a8 8 0 0 1-13.7 5.6L4 16" />
            <path d="M20 4v4h-4M4 20v-4h4" />
          </svg>
        </view>
      </view>
    </view>

    <view class="statline">
      <text class="mono">{{ onlineCount }}</text>
      <text class="t3">台在线</text>
      <text class="sep">·</text>
      <text class="mono">{{ state.devices.length }}</text>
      <text class="t3">台已配对</text>
      <text v-if="state.waiting > 0" class="waiting mono">{{ state.waiting }} 项待处理</text>
    </view>

    <view class="scroll">
      <!-- 等你的事永远在最上面 -->
      <template v-if="lockedDevices.length > 0 || needAuth.length > 0">
        <view class="sect">
          <text>需要你</text>
          <text class="mono t3">{{ lockedDevices.length + needAuth.length }}</text>
        </view>

        <view v-for="d in lockedDevices" :key="`l-${d.deviceId}`" class="row" @tap="open(d)">
          <MossTerm :title="d.name" status="locked" alert :tag="'LOCKED'">
            <view class="need">
              <text class="need-t">这台电脑锁着</text>
              <text class="need-d t2">任务仍在跑，但写操作需要先解锁</text>
              <view class="need-actions">
                <view class="btn alert" @tap.stop="requestUnlock">请求解锁</view>
              </view>
            </view>
          </MossTerm>
        </view>
      </template>

      <view class="sect">
        <text>我的电脑</text>
        <text class="mono t3">{{ otherDevices.length }}</text>
      </view>

      <view v-for="d in otherDevices" :key="d.deviceId" class="row" @tap="open(d)">
        <MossTerm
          :title="d.name"
          :status="statusOf(d)"
          :tag="d.conn === 'online' && d.latencyMs !== undefined ? `${d.latencyMs}ms` : undefined"
          :running="(d.runningCount ?? 0) > 0"
          :alert="d.lock?.locked === true"
        >
          <view class="dev-meta">
            <text class="mono t3">{{ metaLine(d) }}</text>
            <text v-if="d.conn === 'needs-auth'" class="chip">需密码</text>
          </view>
          <view class="dev-use t2">{{ usageLine(d) }}</view>
        </MossTerm>
      </view>

      <view class="adder" @tap="addDevice">
        <text class="plus mono">+</text>
        <text class="adder-t">添加电脑</text>
        <text class="adder-d t3">扫码配对 · 10 秒</text>
      </view>

      <view class="foot t3">
        <text>数据不经过任何服务器</text>
        <text class="mono">/ E2E</text>
      </view>
    </view>

    <!-- PC 被锁时的浮层（不是全屏锁：手机上仍可看，只是不能写） -->
    <view v-if="state.lockDialogFor" class="mask" @tap="dismiss">
      <view class="dialog term" @tap.stop>
        <view class="term-bar">
          <view class="dot" />
          <text class="name">HOST / LOCKED</text>
          <text class="tag mono">REQUEST</text>
        </view>
        <view class="term-body">
          <text class="dlg-t">这台电脑处于锁定状态</text>
          <text class="dlg-d t2">
            你可以请求解锁：电脑上会弹出确认框，30 秒内不确认将自动拒绝。
          </text>
          <view class="dlg-row">
            <view class="btn ghost" @tap="dismiss">取消</view>
            <view class="btn primary" @tap="requestUnlock">请求解锁</view>
          </view>
        </view>
      </view>
    </view>
  </PageShell>
</template>

<style lang="scss" scoped>
.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 0 16px 6px;
}

.brand { display: flex; align-items: baseline; gap: 8px; }

.logo {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--t1);
}

.logo-acc {
  color: var(--acc);
  margin-left: 2px;
}

.ver { font-size: 10px; color: var(--t3); letter-spacing: 0.6px; }

.iconbtn {
  width: 38px;
  height: 38px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  border: 1px solid var(--bd);
  color: var(--t2);
  background: var(--s1);
}

.iconbtn:active { transform: scale(0.94); }
.iconbtn svg { width: 19px; height: 19px; }

.statline {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 2px 16px 4px;
  font-size: 12px;
  color: var(--t3);
}

.statline .mono { color: var(--t1); font-size: 13px; }
.statline .sep { opacity: 0.5; margin: 0 2px; }

.waiting {
  margin-left: auto;
  color: var(--warn);
  font-size: 11px;
  letter-spacing: 0.4px;
}

/* 底部安全距离由 moss.scss 的 .scroll 统一给，这里只管左右 */
.scroll { padding-left: 12px; padding-right: 12px; }

.row { margin-bottom: 10px; }

.dev-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  letter-spacing: 0.2px;
}

.dev-use {
  margin-top: 6px;
  font-size: 13px;
}

.chip {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(232, 194, 74, 0.14);
  color: var(--warn);
  font-size: 10px;
}

.need-t { font-size: 14px; font-weight: 600; color: var(--danger); }
.need-d { display: block; margin-top: 6px; font-size: 12.5px; line-height: 18px; }
.need-actions { display: flex; gap: 8px; margin-top: 12px; }
.need-actions .btn { height: 38px; font-size: 13px; }

/**
 * 告警卡里的动作按钮：红描边 + 红字 + 极淡红底，**不用实心主按钮**。
 * 实心 --acc 在 MOSS 皮肤下是荧光绿，放在红框里像另一个 App 的按钮；
 * 而"请求解锁"是有副作用的一次远程动作，不该是全屏最亮的元素（docs/06 §9）。
 */
.btn.alert {
  background: var(--danger-soft);
  border-color: var(--danger-bd);
  color: var(--danger);
  font-weight: 600;
  padding: 0 20px;
}

.adder {
  margin: 14px 4px 0;
  padding: 16px;
  border-radius: var(--r-md);
  border: 1px dashed var(--bd);
  display: flex;
  align-items: center;
  gap: 10px;
  background: transparent;
}

.adder:active { background: var(--s1); }
.adder .plus { font-size: 18px; color: var(--acc); }
.adder-t { font-size: 14px; }
.adder-d { margin-left: auto; font-size: 11px; }

.foot {
  margin-top: 26px;
  text-align: center;
  font-size: 10.5px;
  letter-spacing: 0.4px;
  opacity: 0.7;
}

.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.62);
  display: flex;
  align-items: flex-end;
  padding: 16px 16px calc(env(safe-area-inset-bottom) + 16px);
}

.dialog { width: 100%; animation: fadeIn var(--t-mid) var(--ease-out); }
.dlg-t { font-size: 15px; font-weight: 600; }
.dlg-d { display: block; margin-top: 8px; font-size: 12.5px; line-height: 19px; }
.dlg-row { display: flex; gap: 10px; margin-top: 16px; }
</style>
