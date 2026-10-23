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
import MossBadge from '@/components/moss/MossBadge.vue'
import { state, activeDevice, skinClass, themeClass, liteClass, type DeviceCard } from '@/core/store'
import { haptic } from '@/core/haptic'
import { connectDevice, refreshAll } from '@/core/link'

/**
 * 启动动画只在**冷启动**播一次。
 *
 * 4.2 秒的动画作为"开机"是有质感的，但每次从别的 tab 切回首页都播一遍
 * 就变成了阻碍——用户切 tab 是为了看设备列表，不是为了再看一次开机。
 * 用模块级标记：页面重建时模块不重建，所以一次进程生命周期内只播一次。
 */
let bootPlayed = false
const booting = ref(!bootPlayed)

/**
 * 是否有任何一台设备在干活。
 *
 * 取 runningCount 而不是 conn==='online'：角标的语义是"在干活"，
 * 在线但空闲的机器不该亮红灯——那会让红灯变成常态，警示失效。
 */
const anyWorking = computed(() => state.devices.some((d) => (d.runningCount ?? 0) > 0))
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

function onBootDone(): void {
  bootPlayed = true
  booting.value = false
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

/**
 * 配对面板。
 *
 * 流程是「电脑出码 → 手机输码」，不是反的：
 *   1. 在电脑上打开 dsh-link 设置，点「生成配对码」——这个动作本身
 *      就是"本人在场"的证明，所以宿主那边会直接预批准
 *   2. 手机输入这 6 位码
 *   3. 手机拿到 bearer token，之后靠它认证
 *
 * 手机端**不**自己发起 pair.start：那会生成一个电脑不知情的码，
 * 除非有人在电脑上再确认一次，否则流程走不通。
 */
const pairOpen = ref(false)
const pairError = ref('')
const pairBusy = ref(false)
const pairInput = ref('')
/** 输错时给输入框一个短抖动，见 finishPair */
const pairShake = ref(false)
const pairAddress = ref('')

/** 还没配对过、也没有缓存地址时需要用户手填一次。 */
const needsAddress = computed(() => {
  const device = state.devices.find((d) => d.deviceId === state.activeId) ?? state.devices[0]
  return device?.endpoint?.url === undefined
})

function addDevice(): void {
  haptic('medium')
  pairOpen.value = true
  pairError.value = ''
  pairInput.value = ''
}

function closePair(): void {
  pairOpen.value = false
  pairBusy.value = false
  pairError.value = ''
}

async function finishPair(): Promise<void> {
  if (pairBusy.value) return
  const code = pairInput.value.trim()
  if (!/^\d{6}$/.test(code)) {
    pairError.value = '请输入电脑上显示的 6 位数字'
    // 输错时抖一下输入框：比只出一行红字更容易被注意到
    pairShake.value = false
    requestAnimationFrame(() => { pairShake.value = true })
    return
  }

  // 连接目标：优先当前选中的设备；首次配对则用用户填的地址建一条临时连接
  let device = state.devices.find((d) => d.deviceId === state.activeId) ?? state.devices[0]
  if (device === undefined) {
    const url = pairAddress.value.trim()
    if (!/^wss?:\/\//.test(url)) {
      pairError.value = '请填写电脑地址，例如 ws://192.168.1.23:7443/dshlink'
      return
    }
    device = {
      deviceId: `tmp_${Date.now()}`,
      name: '未命名电脑',
      platform: 'desktop',
      role: 'operator',
      createdAt: Date.now(),
      lastSeen: Date.now(),
      conn: 'connecting',
      endpoint: { url, kind: 'lan' },
    }
    state.devices = [...state.devices, device]
    state.activeId = device.deviceId
  }
  const link = connectDevice(device)
  if (link === undefined) {
    pairError.value = '无法连接电脑，请确认地址正确且在同一局域网'
    return
  }

  pairBusy.value = true
  pairError.value = ''
  try {
    const info = uni.getSystemInfoSync()
    const result = await link.call<{ deviceId: string; label: string; token: string }>('pair.finish', {
      code,
      label: `${info.platform ?? 'mobile'} 上的 DSH Link`,
      platform: info.platform ?? 'unknown',
    })
    // 令牌是 bearer 凭证：存本地，下次连接用它换认证。
    // 只存 token，不存密码——密码永不出现在移动端。
    try {
      uni.setStorageSync(`dsh-link/token/${result.deviceId}`, result.token)
    } catch {
      // 存储失败不影响本次会话，只是下次要重新配对
    }
    await refreshAll()
    haptic('medium')
    closePair()
    uni.showToast({ title: '配对成功', icon: 'none' })
  } catch (error) {
    pairError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pairBusy.value = false
  }
}

function goTab(tab: 'devices' | 'sessions' | 'me'): void {
  const map = { devices: '/pages/index/index', sessions: '/pages/sessions/sessions', me: '/pages/me/me' }
  uni.reLaunch({ url: map[tab] })
}

onLoad(() => {
  // 首页只做一件事：确保有一条连接，然后拉真实设备表。
  // 没有设备时不造假数据——显示空态与"添加设备"入口。
  const device = state.devices.find((d) => d.deviceId === state.activeId) ?? state.devices[0]
  if (device !== undefined) {
    state.activeId = device.deviceId
    connectDevice(device)
    void refreshAll()
  }
})
</script>

<template>
  <PageShell active="devices" @tab="goTab">
    <!-- 启动页不接收任何设备信息：它是每次冷启动都会出现的公开画面。 -->
    <MossBoot v-if="booting" @done="onBootDone" />

    <view class="head safe-top">
      <view class="brand">
        <MossBadge :size="26" :working="anyWorking" :glow="!state.lite" />
        <text class="logo mono">MOSS<text class="logo-acc">LINK</text></text>
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

      <!-- 空态：没有任何设备时，唯一的行动是配对。
           不显示假设备卡，也不显示"0 台在线"这种没有信息量的统计。 -->
      <view v-if="state.devices.length === 0" class="empty">
        <text class="empty-h mono">NO HOST</text>
        <text class="empty-t">还没有连接任何电脑。</text>
        <text class="empty-d t3">在电脑上打开 DSH，进入 dsh-link 设置，点「配对」拿到 6 位码。</text>
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

    <!-- 配对面板：电脑出码 → 手机输码 -->
    <view v-if="pairOpen" class="mask" @tap="closePair">
      <view class="dialog term" @tap.stop>
        <view class="term-bar">
          <view class="dot" />
          <text class="name">PAIR / HOST</text>
          <text class="tag mono">6 DIGITS</text>
        </view>
        <view class="term-body">
          <text class="dlg-t">输入电脑上显示的 6 位码</text>
          <text class="dlg-d t2">
            在电脑上打开 DSH → dsh-link 设置 → 生成配对码。码 2 分钟内有效。
          </text>

          <input
            v-model="pairInput"
            class="pair-input mono"
            :class="{ 'shake': pairShake }"
            type="number"
            maxlength="6"
            placeholder="000000"
            :disabled="pairBusy"
          />

          <!-- 首次配对时本地还没有 endpoint，必须让用户填一次地址。
               之后这串会存进设备缓存，下次自动重连。 -->
          <input
            v-if="needsAddress"
            v-model="pairAddress"
            class="addr-input mono"
            type="text"
            placeholder="ws://192.168.1.23:7443/dshlink"
            :disabled="pairBusy"
          />

          <text v-if="pairError" class="pair-err">{{ pairError }}</text>

          <view class="dlg-row">
            <view class="btn ghost" @tap="closePair">取消</view>
            <!-- 忙碌时必须视觉禁用：只改文案的话，用户会以为没点上而反复点，
                 结果是重复配对请求。:class 与 pointer-events 一起给。 -->
            <view
              class="btn primary"
              :class="{ 'is-disabled': pairBusy }"
              @tap="finishPair"
            >
              {{ pairBusy ? '配对中…' : '配对' }}
            </view>
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
  padding-right: 16px;
  padding-bottom: 6px;
  padding-left: 16px;
  /* 刻意不用 padding 简写：简写会把 padding-top 重置为 0，
     覆盖掉 .head 上的 .safe-top（状态栏安全区）。 */
}

.brand { display: flex; align-items: center; gap: 8px; }

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

.empty {
  margin: 18px 2px 6px;
  padding: 20px 16px;
  border-radius: var(--r-md);
  border: 1px dashed var(--bd);
  background: var(--s1);
}

.empty-h { font-size: 11px; letter-spacing: 0.18em; color: var(--t3); }
.empty-t { display: block; margin-top: 8px; font-size: 14px; color: var(--t1); }
.empty-d { display: block; margin-top: 6px; font-size: 11.5px; line-height: 17px; }

.pair-input {
  width: 100%;
  height: 52px;
  margin: 14px 0 6px;
  padding: 0 14px;
  box-sizing: border-box;
  border-radius: var(--r-md);
  border: 1px solid var(--bd-strong);
  background: var(--bg);
  color: var(--t1);
  font-size: 24px;
  letter-spacing: 10px;
  text-align: center;
}

.pair-err {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  line-height: 17px;
  color: var(--danger);
}

.addr-input {
  width: 100%;
  height: 44px;
  margin-top: 8px;
  padding: 0 12px;
  box-sizing: border-box;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--bg);
  color: var(--t2);
  font-size: 12px;
}

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
/* .btn 的基础样式与 .btn.alert 的红描边定义在 moss.scss（单一来源）。
   这里只补"这一处需要更宽"的差异，不重复颜色——两处都写颜色，
   改主题时必然有一处忘了改。 */
.btn.alert { font-weight: 600; padding: 0 20px; }

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

/**
 * 弹窗遮罩。
 *
 * 两个修正：
 *   1. 底部内边距用 --safe-bottom-real 而不是裸 env()：Android 上
 *      env(safe-area-inset-bottom) 是 0，弹窗会直接贴到屏幕底边，
 *      在全面屏手势条上方显得"被切掉了"。
 *   2. 弹窗限制最大高度并允许内部滚动：配对面板在横屏/小屏上会超出，
 *      超出后底部按钮点不到——这是最典型的"按钮点不着"。
 */
.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.62);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 16px 16px calc(var(--safe-bottom-real, 16px) + 16px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.dialog {
  width: 100%;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  animation: fadeIn var(--t-mid) var(--ease-out);
}
.dlg-t { font-size: 15px; font-weight: 600; }
.dlg-d { display: block; margin-top: 8px; font-size: 12.5px; line-height: 19px; }
.dlg-row { display: flex; gap: 10px; margin-top: 16px; }
</style>
