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
import MossSheet, { type SheetItem } from '@/components/MossSheet.vue'
import MossBadge from '@/components/moss/MossBadge.vue'
import { state, activeDevice, skinClass, themeClass, liteClass, type DeviceCard } from '@/core/store'
import { haptic } from '@/core/haptic'
import { connectDevice, disconnect, refreshAll, currentLink } from '@/core/link'
import { decodePairUri } from '@dsh-link/protocol'

/**
 * 启动动画只在**冷启动**播一次。
 *
 * 4.2 秒的动画作为"开机"是有质感的，但每次从别的 tab 切回首页都播一遍
 * 就变成了阻碍——用户切 tab 是为了看设备列表，不是为了再看一次开机。
 * 用模块级标记：页面重建时模块不重建，所以一次进程生命周期内只播一次。
 */
/*
 * 启动动画：一次进程生命周期内只播一次。
 *
 * 标记放 storage 而不是模块变量：reLaunch 切 tab 会重建页面，
 * 模块变量在某些平台上会随页面一起重置，表现就是"每点一次设备 tab
 * 就重播一遍 4.3 秒开机动画"。storage 是进程级的，可靠。
 * 冷启动时由 App.vue 清掉这个键。
 */
let bootPlayed = (() => {
  try { return uni.getStorageSync('dsh-link/booted') === '1' } catch { return false }
})()
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

/** 统一弹层控制器（与对话页同一套交互语言）。 */
interface SheetState {
  visible: boolean
  kind: 'menu' | 'confirm' | 'prompt' | 'info'
  title?: string
  items?: SheetItem[]
  message?: string
  value?: string
  placeholder?: string
  confirmText?: string
  onSelect?: (index: number) => void
  onConfirm?: (text: string) => void
}
const sheet = ref<SheetState>({ visible: false, kind: 'menu' })

function openSheet(opts: Omit<SheetState, 'visible'>): void {
  sheet.value = { visible: true, ...opts }
}

function onSheetSelect(index: number): void { sheet.value.onSelect?.(index) }
function onSheetConfirm(text: string): void { sheet.value.onConfirm?.(text) }

function statusOf(d: DeviceCard): 'online' | 'connecting' | 'offline' | 'needs-auth' | 'locked' {
  // 非当前连接的设备没有本地连接状态，用宿主下发的 online 判断
  if (d.conn !== 'online' && d.online === false) return 'offline'
  if (d.conn === 'offline') return 'offline'
  if (d.conn === 'needs-auth') return 'needs-auth'
  if (d.conn === 'connecting') return 'connecting'
  if (d.lock?.locked) return 'locked'
  return 'online'
}

/**
 * 设备卡的元信息行。
 *
 * 修正过两处：
 *   1. 原来读 `d.host?.platform`，但 DeviceCard 的字段是 `platform`（无 host 嵌套），
 *      于是一直拿不到平台名——卡片看起来"什么信息都没有"。
 *   2. 原来离线时硬编码「上次在线 3 小时前」，那是演示数据留下的假文案。
 *      现在按 lastSeen 算相对时间。
 */
function metaLine(d: DeviceCard): string {
  const bits: string[] = []
  if (d.platform) bits.push(platformLabel(d.platform))
  if (d.endpoint?.kind) {
    bits.push(d.endpoint.kind === 'lan' ? '局域网' : d.endpoint.kind === 'relay' ? '中继' : d.endpoint.kind === 'tailscale' ? 'Tailscale' : '自定义')
  }
  /*
   * 地址要显示在卡片上，不是只藏在详情里。
   *
   * 用户最常见的疑问是"我连的到底是哪台机器"——同一台 Mac 有两个网卡时，
   * IP 是唯一能区分的东西。之前只显示"局域网"，等于没说。
   */
  const addr = d.endpoint?.url ?? ''
  const host = addr.replace(/^wss?:\/\//, '').replace(/\/.*$/, '')
  if (host.length > 0) bits.push(host)

  if (d.conn === 'offline' && typeof d.lastSeen === 'number') {
    bits.push(`上次在线 ${relativeTime(d.lastSeen)}`)
  } else if (typeof d.latencyMs === 'number') {
    bits.push(`${d.latencyMs}ms`)
  }
  return bits.join(' · ')
}

function platformLabel(p: string): string {
  switch (p) {
    case 'darwin': return 'macOS'
    case 'win32': return 'Windows'
    case 'linux': return 'Linux'
    case 'ios': return 'iOS'
    case 'android': return 'Android'
    default: return p
  }
}

/** 相对时间：刚才 / N 分钟前 / N 小时前 / N 天前。 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (!Number.isFinite(diff) || diff < 0) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/**
 * 设备卡第三行：这台机器上发生了什么。
 *
 * 空的时候返回空串而不是 '—'：一个孤零零的破折号看起来像加载失败。
 *
 * 当前连接的那台设备用本地已知的会话数（刚拉过 session.list）；
 * 其它设备宿主不会下发统计，就不写——比编一个数字诚实。
 */
function usageLine(d: DeviceCard): string {
  if (d.lock?.locked) return '已锁定 · 任务仍在后台继续'

  const isActive = d.deviceId === state.activeId
  const sessions = isActive ? state.sessions : []
  const total = d.sessionCount ?? (isActive ? sessions.length : undefined)
  const running = d.runningCount ?? (isActive ? sessions.filter((x) => x.status === 'running').length : undefined)
  const waiting = isActive
    ? sessions.filter((x) => x.status === 'waiting-approval' || x.status === 'waiting-input').length
    : 0

  const parts: string[] = []
  if (total !== undefined && total > 0) parts.push(`${String(total)} 个会话`)
  if (running !== undefined && running > 0) parts.push(`${String(running)} 个运行中`)
  if (waiting > 0) parts.push(`${String(waiting)} 个待处理`)
  return parts.join(' · ')
}

/**
 * 费用与峰谷。
 *
 * 数据全部来自宿主的 dsh-cost-meter（我们只转发）。宿主没装就整块不显示——
 * 显示一个"¥0.00"比不显示更糟，用户会以为真的没花钱。
 */
interface CostInfo {
  available: boolean
  session?: unknown
  peak?: { peak: boolean; weekend?: boolean; msUntilSwitch: number; next: 'peak' | 'offPeak' } | null
}
const cost = ref<CostInfo | undefined>(undefined)

function costText(): string {
  const c = cost.value
  if (c?.available !== true) return ''
  const s = c.session as { total?: { amount?: number; currency?: string }; cost?: number; usd?: number } | null | undefined
  if (s === null || s === undefined) return ''
  const amount = typeof s.total?.amount === 'number' ? s.total.amount
    : typeof s.cost === 'number' ? s.cost
      : typeof s.usd === 'number' ? s.usd : undefined
  if (amount === undefined) return ''
  const cur = s.total?.currency ?? 'USD'
  const symbol = cur === 'CNY' ? '¥' : '$'
  return `${symbol}${amount.toFixed(amount < 0.01 ? 4 : 2)}`
}

/** 峰谷提醒：只给"还有多久切换"，不说"省钱多少"——金额口径不归我们解释。 */
function peakText(): string {
  const p = cost.value?.peak
  if (p === null || p === undefined) return ''
  const mins = Math.round(p.msUntilSwitch / 60_000)
  const when = mins >= 90 ? `${Math.round(mins / 60)} 小时` : `${String(mins)} 分钟`
  if (p.weekend === true) return '周末谷价'
  return p.peak ? `峰时计价 · ${when}后转谷时` : `谷时计价 · ${when}后转峰时`
}

function peakTone(): 'peak' | 'valley' | '' {
  const p = cost.value?.peak
  if (p === null || p === undefined) return ''
  return p.peak ? 'peak' : 'valley'
}

async function loadCost(): Promise<void> {
  const link = currentLink()
  if (link === undefined) { cost.value = undefined; return }
  // 用最近一次会话的费用：设备卡是"这台机器上正在发生的事"的入口
  const sessionId = state.sessions[0]?.id ?? ''
  try {
    cost.value = await link.call<CostInfo>('cost.summary', sessionId.length > 0 ? { sessionId } : {})
  } catch {
    cost.value = undefined
  }
}

function onBootDone(): void {
  bootPlayed = true
  booting.value = false
  try { uni.setStorageSync('dsh-link/booted', '1') } catch { /* 存不下就退化成每次播 */ }
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

/**
 * 设备长按菜单（设计文档 08 §3.1 的要求，之前漏实现）。
 *
 * 为什么是长按而不是卡片上放按钮：
 *   卡片是"点进去"的主要入口，放按钮会把可点区域切碎，
 *   而管理是低频操作，藏进长按正合适。
 */
function deviceMenu(d: DeviceCard): void {
  haptic('medium')
  openSheet({
    kind: 'menu',
    title: d.name,
    items: [
      { label: '重命名', hint: '改的是本机显示名，不影响电脑' },
      { label: '查看详情', hint: '设备 ID / 地址 / 状态' },
      { label: '断开连接', hint: '只是断线，配对关系保留' },
      { label: '移除设备', hint: '需要重新配对才能再连', danger: true },
    ],
    onSelect: (i) => {
      if (i === 0) void renameDevice(d)
      else if (i === 1) void showDeviceDetail(d)
      else if (i === 2) disconnectDevice(d)
      else if (i === 3) void removeDevice(d)
    },
  })
}

async function renameDevice(d: DeviceCard): Promise<void> {
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  openSheet({
    kind: 'prompt',
    title: '重命名设备',
    message: '只改本机显示名，电脑上不受影响。',
    value: d.name,
    placeholder: '给这台电脑起个名字',
    confirmText: '保存',
    onConfirm: (text) => {
      const label = text.trim()
      if (label.length === 0) return
      void link.call('device.rename', { deviceId: d.deviceId, label }).then(() => {
        const idx = state.devices.findIndex((x) => x.deviceId === d.deviceId)
        if (idx >= 0) {
          const cur = state.devices[idx]
          if (cur !== undefined) state.devices[idx] = { ...cur, name: label }
        }
        uni.showToast({ title: '已重命名', icon: 'none' })
      }).catch((e: unknown) => {
        uni.showToast({ title: e instanceof Error ? e.message.slice(0, 16) : '失败', icon: 'none' })
      })
    },
  })
}

function showDeviceDetail(d: DeviceCard): void {
  const lines = [
    `名称：${d.name}`,
    `平台：${platformLabel(d.platform)}`,
    `角色：${d.role}`,
    `设备 ID：${d.deviceId}`,
    `连接地址：${d.endpoint?.url ?? '（未知）'}`,
    `状态：${statusText(statusOf(d))}`,
    d.lastSeen ? `最近活跃：${relativeTime(d.lastSeen)}` : '',
  ].filter((x) => x.length > 0)
  openSheet({ kind: 'info', title: '设备详情', message: lines.join('\n') })
}

function statusText(s: ReturnType<typeof statusOf>): string {
  switch (s) {
    case 'online': return '在线'
    case 'connecting': return '连接中'
    case 'offline': return '离线'
    case 'needs-auth': return '需配对'
    case 'locked': return '已锁定'
    default: return '未知'
  }
}

function disconnectDevice(d: DeviceCard): void {
  disconnect()
  const idx = state.devices.findIndex((x) => x.deviceId === d.deviceId)
  if (idx >= 0) {
    const cur = state.devices[idx]
    if (cur !== undefined) state.devices[idx] = { ...cur, conn: 'offline' }
  }
  haptic('light')
  uni.showToast({ title: '已断开', icon: 'none' })
}

async function removeDevice(d: DeviceCard): Promise<void> {
  openSheet({
    kind: 'confirm',
    title: `移除「${d.name}」`,
    message: '这台设备需要重新配对才能再连接。已有会话不受影响。',
    confirmText: '移除',
    onConfirm: () => {
      const link = currentLink()
      void (async () => {
        if (link !== undefined) {
          try { await link.call('device.revoke', { deviceId: d.deviceId }) } catch { /* 撤销失败也允许本地移除 */ }
        }
        state.devices = state.devices.filter((x) => x.deviceId !== d.deviceId)
        if (state.activeId === d.deviceId) state.activeId = state.devices[0]?.deviceId ?? ''
        haptic('heavy')
        uni.showToast({ title: '已移除', icon: 'none' })
      })()
    },
  })
}

function addDevice(): void {
  haptic('medium')
  pairOpen.value = true
  pairError.value = ''
  pairInput.value = ''
}

/**
 * 扫码配对。
 *
 * 二维码内容由宿主生成（`dshlink://pair?h=..&p=..&c=..`），扫码后
 * 一次拿到「地址 + 配对码」——用户不用再手抄 ws:// 地址，也不用
 * 在两个界面之间切换。
 *
 * 手动输入仍然是保底：摄像头坏了、码看不清、或手机不方便扫码时，
 * 用户仍能靠「地址 + 6 位码」完成配对。
 */
function scanToPair(): void {
  haptic('light')
  uni.scanCode({
    onlyFromCamera: false,
    scanType: ['qrCode'],
    success: (res) => {
      const raw = typeof res.result === 'string' ? res.result : ''
      const parsed = decodePairUri(raw)
      if (!parsed.ok) {
        // 失败时把**原始内容**也显示出来（截断）。
        // 排查这类问题时，"看到的是什么"比"我判断它不对"有用得多——
        // 扫码 SDK 可能改写内容（大写、编码、加前后缀），
        // 不看到原文就只能靠猜。
        const preview = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw
        pairError.value =
          (parsed.reason === 'not-pair-uri'
            ? '这不是 MOSS Link 的配对码'
            : '配对码格式不对，请让电脑重新生成') +
          (preview.length > 0 ? `（扫到：${preview}）` : '（扫到空内容）')
        return
      }
      pairAddress.value = parsed.wsUrl
      pairInput.value = parsed.payload.code
      pairError.value = ''
      void finishPair()
    },
    fail: () => {
      // 用户取消扫码不是错误，不弹提示
    },
  })
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

  /**
   * 决定连哪台机器。
   *
   * 这里踩过一个很隐蔽的坑：原来的逻辑是「优先当前设备，没有才用输入框的地址」。
   * 于是**已经有设备的情况下，扫码给的地址被完全忽略**——用的是上次的旧地址
   * （可能已离线、或换了网段），表现就是"扫码识别成功，然后一直配对中直到超时"。
   *
   * 正确顺序应该是：**本次明确提供的地址优先**。
   * 用户在配对界面填/扫出来的地址，就是他想连的那台机器。
   */
  const typedUrl = pairAddress.value.trim()
  const hasTypedUrl = /^wss?:\/\//.test(typedUrl)

  let device = state.devices.find((d) => d.deviceId === state.activeId) ?? state.devices[0]

  if (hasTypedUrl) {
    const existing = state.devices.find((d) => d.endpoint?.url === typedUrl)
    if (existing !== undefined) {
      // 地址已经配对过：直接复用，避免建出重复设备卡
      device = existing
      state.activeId = existing.deviceId
    } else {
      // 新地址：建一条临时设备（配对成功后会从 device.list 拿到真实 id）
      device = {
        deviceId: `tmp_${Date.now()}`,
        name: '未命名电脑',
        platform: 'desktop',
        role: 'operator',
        createdAt: Date.now(),
        lastSeen: Date.now(),
        conn: 'connecting',
        endpoint: { url: typedUrl, kind: typedUrl.startsWith('wss:') ? 'relay' : 'lan' },
      }
      state.devices = [...state.devices, device]
      state.activeId = device.deviceId
    }
  } else if (device === undefined) {
    pairError.value = '请填写电脑地址，例如 ws://192.168.1.23:7443/dshlink'
    return
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
    void refreshAll().then(() => loadCost())
  }
})
</script>

<template>
  <PageShell active="devices" @tab="goTab">
    <!-- 启动页不接收任何设备信息：它是每次冷启动都会出现的公开画面。 -->
    <MossBoot v-if="booting" @done="onBootDone" />

    <MossSheet
      :visible="sheet.visible"
      :kind="sheet.kind"
      :title="sheet.title"
      :items="sheet.items ?? []"
      :message="sheet.message ?? ''"
      :value="sheet.value ?? ''"
      :placeholder="sheet.placeholder ?? ''"
      :confirm-text="sheet.confirmText ?? '确定'"
      @update:visible="sheet.visible = $event"
      @select="onSheetSelect"
      @confirm="onSheetConfirm"
    />

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

      <view class="dev-grid">
        <view
          v-for="d in otherDevices"
          :key="d.deviceId"
          class="row"
          @tap="open(d)"
          @longpress="deviceMenu(d)"
        >
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
          <!-- usageLine 没内容时整行不渲染：一个孤零零的"—"看起来像加载失败 -->
          <view v-if="usageLine(d).length > 0" class="dev-use t2">{{ usageLine(d) }}</view>
          <!-- 费用与峰谷：只在宿主装了 dsh-cost-meter 时出现 -->
          <view
            v-if="d.deviceId === state.activeId && (costText().length > 0 || peakText().length > 0)"
            class="dev-cost"
          >
            <text v-if="costText().length > 0" class="cost mono">本次 {{ costText() }}</text>
            <text v-if="peakText().length > 0" class="peak mono" :class="peakTone()">{{ peakText() }}</text>
          </view>
          </MossTerm>
        </view>
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
          <text class="dlg-t">扫描电脑上的配对码</text>
          <text class="dlg-d t2">
            在电脑上打开 MOSS Link 设置 → 生成配对码。扫码自动填地址与码；也可以手动输入。
          </text>

          <!-- 扫码是主路径：一次拿到地址+码，不用手抄 ws:// -->
          <!-- 图标用纯 CSS 画：uni-app 的 App 端对内联 SVG 支持不稳定，
               会出现"图标消失但文字在"的情况。四个角 + 中间扫描线足够表意。 -->
          <view class="scan-btn" :class="{ 'is-disabled': pairBusy }" @tap="scanToPair">
            <view class="scan-ico">
              <view class="scan-corner tl" />
              <view class="scan-corner tr" />
              <view class="scan-corner bl" />
              <view class="scan-corner br" />
              <view class="scan-line" />
            </view>
            <text class="scan-t">扫码配对</text>
          </view>

          <view class="or-row"><view class="or-line" /><text class="or-t t3">或手动输入</text><view class="or-line" /></view>

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

/**
 * 扫码按钮。
 *
 * 居中要写三处，少一处在某些 WebView 上就会偏：
 *   - flex + justify-content: center 负责「图标 + 文字」整体居中
 *   - text-align: center 兜住 uni-app 把 <text> 渲染成 inline 元素的情况
 *     （inline 元素不参与 flex 的 justify，会贴左）
 *   - line-height 与 height 相等，让文字在行盒里垂直居中
 */
.scan-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 52px;
  line-height: 52px;
  text-align: center;
  margin-top: 16px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd-strong);
  background: var(--acc-soft);
  color: var(--acc);
  font-size: 15px;
  font-weight: 600;
}

.scan-btn:active { transform: scale(0.985); }

/* 扫码图标：四个角 + 扫描线，纯 CSS */
.scan-ico {
  position: relative;
  width: 20px;
  height: 20px;
  flex: none;
}

.scan-corner {
  position: absolute;
  width: 7px;
  height: 7px;
  border: 2px solid currentColor;
}

.scan-corner.tl { top: 0; left: 0; border-right: 0; border-bottom: 0; border-top-left-radius: 2px; }
.scan-corner.tr { top: 0; right: 0; border-left: 0; border-bottom: 0; border-top-right-radius: 2px; }
.scan-corner.bl { bottom: 0; left: 0; border-right: 0; border-top: 0; border-bottom-left-radius: 2px; }
.scan-corner.br { bottom: 0; right: 0; border-left: 0; border-top: 0; border-bottom-right-radius: 2px; }

.scan-line {
  position: absolute;
  left: 2px;
  right: 2px;
  top: 50%;
  height: 2px;
  margin-top: -1px;
  border-radius: 1px;
  background: currentColor;
}

/* 文字块自己去撑，避免 inline 元素贴左 */
.scan-t {
  line-height: 1;
  display: inline-block;
  text-align: center;
}

.or-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 2px;
}

.or-line { flex: 1; height: 1px; background: var(--bd); }
.or-t { font-size: 10.5px; letter-spacing: 0.1em; }

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
.scroll {
  padding-left: var(--gutter, 12px);
  padding-right: var(--gutter, 12px);
}

/*
 * 设备卡列表。
 *
 * 手机单列；平板两列（--grid-devices 由 tokens.scss 的断点给出）。
 * 用 grid 而不是 flex-wrap：flex-wrap 下最后一行不满时卡片会被拉伸，
 * 两列宽度不一致看起来像 bug。
 */
.dev-grid {
  display: grid;
  grid-template-columns: repeat(var(--grid-devices, 1), minmax(0, 1fr));
  gap: 10px;
}

.row { margin-bottom: 0; }

.dev-cost {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}

.cost { font-size: 11px; color: var(--t2); }
.peak { font-size: 10.5px; }
.peak.peak { color: var(--warn); }
.peak.valley { color: var(--acc); }

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
