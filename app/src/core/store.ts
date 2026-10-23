/**
 * 全局状态：皮肤、明暗、设备列表、锁屏。
 *
 * 不引 pinia：这个应用的状态只有一屏到一屏的传值，reactive 单例足够。
 * 依赖越少，首包越小（首包预算是硬指标，见 docs/05 §8）。
 */

import { computed, reactive, watch } from 'vue'
import type { DeviceInfo, HostInfo, LockState } from '@dsh-link/protocol'

export type SkinMode = 'auto' | 'moss' | '550w'

export interface DeviceCard extends DeviceInfo {
  /** 连接态与锁态是正交的两个维度，不要合成一个字段（见 docs/02 §6.3） */
  conn: 'offline' | 'connecting' | 'needs-auth' | 'online'
  latencyMs?: number
  host?: HostInfo
  lock?: LockState
  sessionCount?: number
  runningCount?: number
  endpointKind?: 'lan' | 'relay' | 'tailscale'
  /**
   * 连接地址。宿主**不**下发它（那是客户端的事），由配对时写入本地缓存。
   * 没有它就无法连接——首页据此显示"需要重新配对"。
   */
  endpoint?: { url: string; kind: 'lan' | 'relay' | 'tailscale' | 'custom' }
  /**
   * 宿主下发的真实在线状态（有已认证连接即为 true）。
   * 客户端自己只知道"当前连接的那台"，其它设备只能靠这个字段。
   */
  online?: boolean
}

/** 会话行（列表页用；字段与协议 SessionSummary 对齐）。 */
export interface SessionRow {
  id: string
  workspaceId: string
  title: string
  status: 'idle' | 'running' | 'waiting-approval' | 'waiting-input' | 'done' | 'error'
  updatedAt: number
  model?: string
  excerpt?: string
}

/** 工作区行。 */
export interface WorkspaceRow {
  id: string
  name: string
  path: string
  pinned?: boolean
  sessionCount?: number
  /**
   * 该工作区包含的会话 id。
   *
   * dsh 的 SessionSummary 不带 workspaceId，归属只能从 Workspace.sessionIds 反查
   * （见 packages/workspace/workspace/src/types.ts）。少了它就无法按工作区分组。
   */
  sessionIds?: string[]
  updatedAt?: number
}

interface AppState {
  skinMode: SkinMode
  light: boolean
  lite: boolean
  devices: DeviceCard[]
  /** 会话列表（真实数据；空数组 = 还没拉到或真的没有）。 */
  sessions: SessionRow[]
  /** 工作区列表。 */
  workspaces: WorkspaceRow[]
  activeId: string
  /** 当前是否有"在等你"的事（审批 / 提问）。它决定底部会话角标，不决定皮肤。 */
  waiting: number
  /**
   * 当前页面是否处于"危险确认"场景（锁屏 / 撤销设备 / 安装插件确认）。
   * 只有它为 true 时，auto 皮肤才整页切 550W。
   */
  alertPage: boolean
  /** 本机（App 自身）的锁屏——在 PC 被锁时的请求解锁浮层，不是全屏锁 */
  lockDialogFor: string
}

export const state = reactive<AppState>({
  skinMode: 'auto',
  light: false,
  lite: false,
  devices: [],
  sessions: [],
  workspaces: [],
  activeId: '',
  waiting: 0,
  alertPage: false,
  lockDialogFor: '',
})

/* ── 偏好持久化 ────────────────────────────────────────────────────────
 * 只存"用户的选择"，不存设备列表：
 * 设备列表是连出来的事实，缓存下来的在线状态下次启动就是假的，
 * 那比空列表更糟——用户会以为机器还连着。
 *
 * 三个字段分开判断"有没有存过"：都存过才敢说"用户选过了"。
 * 用户没动过浅色开关，就该继续跟随系统（App.vue 的 onLaunch 靠这个标记决定）。
 */
const PREFS_KEY = 'dsh-link/prefs'

/**
 * 用户是否**亲手**改过这些开关。
 *
 * 这个标记决定冷启动时要不要跟随系统主题：改过就不能覆盖，
 * 否则用户在设置里选的浅色会在下次启动被系统悄悄改回去——
 * 那是"设置不生效"最典型的形态。
 *
 * 注意 `lightStored` 必须在**用户操作时**置位，不能只在读缓存时置位：
 * 只在读缓存置位的话，第一次手动切换当时生效、重启就丢，更难排查。
 */
export const prefs = { lightStored: false, liteStored: false, skinStored: false }

/** 用户在"我的"页面里动过的开关，统一在这里标记，避免散落在各页面。 */
export function markUserPreference(field: 'light' | 'lite' | 'skin'): void {
  if (field === 'light') prefs.lightStored = true
  else if (field === 'lite') prefs.liteStored = true
  else prefs.skinStored = true
  savePrefs()
}

;(function loadPrefs() {
  try {
    const raw = uni.getStorageSync(PREFS_KEY)
    if (!raw) return
    const p = JSON.parse(String(raw)) as Partial<Pick<AppState, 'skinMode' | 'light' | 'lite'>>
    if (p.skinMode === 'auto' || p.skinMode === 'moss' || p.skinMode === '550w') {
      state.skinMode = p.skinMode
      prefs.skinStored = true
    }
    if (typeof p.light === 'boolean') { state.light = p.light; prefs.lightStored = true }
    if (typeof p.lite === 'boolean') { state.lite = p.lite; prefs.liteStored = true }
  } catch {
    // 读不出来就按默认走，不值得为一次坏缓存弹个错
  }
})()

/**
 * 设备表持久化。
 *
 * 这是一个**真实踩到的可用性缺陷**：设备表以前完全不落盘，
 * 而令牌是按 deviceId 存的（`dsh-link/token/<deviceId>`）。
 * 结果就是——配对成功、关掉 App、再打开，设备列表空了，
 * 令牌还在存储里但没有任何 deviceId 能指向它，等于必须重新配对。
 *
 * 只持久化"重建连接所需的最小信息"：
 *   deviceId / name / platform / role / createdAt / lastSeen / endpoint
 * 不存 conn、latencyMs、lock 这些瞬时字段——它们每次启动都会重新测量，
 * 存下来只会让界面在启动瞬间显示过期状态。
 */
const DEVICES_KEY = 'dsh-link/devices'

interface PersistedDevice {
  deviceId: string
  name: string
  platform: string
  role: string
  createdAt: number
  lastSeen: number
  endpoint?: { url: string; kind: 'lan' | 'relay' | 'tailscale' | 'custom' }
  /**
   * 宿主下发的真实在线状态（有已认证连接即为 true）。
   * 客户端自己只知道"当前连接的那台"，其它设备只能靠这个字段。
   */
  online?: boolean
}

;(function loadDevices() {
  try {
    const raw = uni.getStorageSync(DEVICES_KEY)
    if (!raw) return
    const parsed = JSON.parse(String(raw)) as { devices?: PersistedDevice[]; activeId?: string }
    const list = parsed.devices
    if (!Array.isArray(list)) return
    state.devices = list
      .filter((d) => typeof d?.deviceId === 'string' && d.deviceId.length > 0)
      .map((d) => ({
        deviceId: d.deviceId,
        name: d.name || '未命名设备',
        platform: (d.platform || 'desktop') as DeviceInfo['platform'],
        role: (d.role || 'operator') as DeviceInfo['role'],
        createdAt: d.createdAt || Date.now(),
        lastSeen: d.lastSeen || Date.now(),
        // 启动时一律标 connecting：真实状态要连上才知道，不能沿用上次的"在线"
        conn: 'connecting' as const,
        ...(d.endpoint === undefined ? {} : { endpoint: d.endpoint }),
      }))
    if (typeof parsed.activeId === 'string' && parsed.activeId.length > 0) {
      state.activeId = parsed.activeId
    }
  } catch {
    // 缓存坏了就当没有：重新配对总比启动崩溃好
  }
})()

/** 设备表落盘。设备或当前选中项变化时自动调用。 */
function saveDevices(): void {
  try {
    uni.setStorageSync(
      DEVICES_KEY,
      JSON.stringify({
        activeId: state.activeId,
        devices: state.devices.map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          platform: d.platform,
          role: d.role,
          createdAt: d.createdAt,
          lastSeen: d.lastSeen,
          ...(d.endpoint === undefined ? {} : { endpoint: d.endpoint }),
        })),
      }),
    )
  } catch {
    // 存不下不影响当前会话，只是下次启动要重配
  }
}

watch(
  () => [state.devices, state.activeId] as const,
  () => { saveDevices() },
  { deep: true },
)

/** 落盘。watch 与显式调用共用同一份，避免两处写法不一致。 */
function savePrefs(): void {
  try {
    uni.setStorageSync(
      PREFS_KEY,
      JSON.stringify({ skinMode: state.skinMode, light: state.light, lite: state.lite }),
    )
  } catch {
    // 存储满了/被禁用：不影响当前会话的视觉
  }
}

watch(
  () => [state.skinMode, state.light, state.lite] as const,
  () => { savePrefs() },
)

/**
 * 皮肤：`auto` 时只有**锁屏与危险确认**整页切 550W，其余 MOSS。
 *
 * 为什么"有等待审批"不整页变红：一旦红色成了常态，它就再也起不到警示作用。
 * 等待只用元素级提示（那张卡描边变红 + 黄点），整页变色留给"要你动手做危险的事"。
 */
export const skin = computed<'moss' | '550w'>(() => {
  if (state.skinMode !== 'auto') return state.skinMode
  return state.alertPage ? '550w' : 'moss'
})

export const skinClass = computed(() => `skin-${skin.value}`)
export const themeClass = computed(() => (state.light ? 'is-light' : 'is-dark'))
export const liteClass = computed(() => (state.lite ? 'is-lite' : ''))

export const activeDevice = computed(() =>
  state.devices.find((d) => d.deviceId === state.activeId),
)

/** "谁在等我"——首页第一屏要回答的问题，而不是"我有几台机器" */
export const waitingDevices = computed(() =>
  state.devices.filter((d) => d.lock?.locked || d.conn === 'needs-auth'),
)
