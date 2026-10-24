/**
 * App 侧连接层：把 transport 接到 store 上。
 *
 * 为什么单独一个文件而不是在页面里 new Link：
 *   - 设备列表、会话列表、对话页都要用同一条连接，页面各建一条会互相抢 socket
 *   - 断线重连、设备状态更新需要一个统一的地方，否则每页一套逻辑必然不一致
 *   - 页面卸载不能断连接（用户切 tab 不应该重连一次）
 *
 * 设计取舍：这里只管"连接与转发"，不持有 UI 状态。UI 通过 store 读写。
 */

import type { DeviceCard, SessionRow, WorkspaceRow } from './store'
import { state } from './store'
import { Link, type LinkStatus } from './transport'

/** 一次连接的上下文：连接 + 它属于哪台设备。 */
interface Attached {
  readonly deviceId: string
  /** 建立这条连接时用的地址。地址变了必须重建，不能复用旧 socket。 */
  readonly url: string
  readonly link: Link
}

let attached: Attached | undefined
/** 会话事件监听器（由对话页注册，切页时替换）。 */
let sessionListener: ((method: string, payload: unknown, channel?: string) => void) | undefined

/** 当前连接（供页面判断"能不能发消息"）。 */
export function currentLink(): Link | undefined {
  return attached?.link
}

export function connectionStatus(): LinkStatus {
  return attached?.link.status ?? 'offline'
}

/**
 * 连接一台设备。
 *
 * 幂等：已经连着同一台就直接返回，不重建 socket——切 tab 频繁调用也不会有副作用。
 */
/**
 * 连接一台设备。
 *
 * 两个关键判断：
 *
 * 1. **已有连接要检查地址是否一致**。原来只比 deviceId：同一台机器换了地址
 *    （从局域网切到中继、或 DHCP 换了 IP）时，会继续复用旧 socket 连旧地址，
 *    表现是"配对一直超时"。
 *
 * 2. **不因离线状态短路**。原来 `conn === 'offline'` 直接返回 undefined，
 *    但用户主动点「配对」就是想连——离线只是上一次的观测结果，
 *    不该让它阻止一次新的尝试。
 */
/** 用户主动断开标记：主动断开后不允许自动重连。 */
let manualClose = false
let retry = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined

function scheduleReconnect(device: DeviceCard): void {
  if (retryTimer !== undefined) return
  const delay = Math.min(30_000, 1000 * 2 ** retry)
  retry += 1
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    // 期间可能已经换了设备或用户手动断开
    if (manualClose || state.activeId !== device.deviceId) return
    connectDevice(device)
  }, delay)
}

/** 手动断开：置标记并清掉待执行的重连。 */
export function disconnectManual(): void {
  manualClose = true
  retry = 0
  if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined }
  disconnect()
}

export function connectDevice(device: DeviceCard): Link | undefined {
  const nextUrl = device.endpoint?.url
  if (attached !== undefined) {
    const sameUrl = attached.url === nextUrl
    if (attached.deviceId === device.deviceId && sameUrl) return attached.link
    // deviceId 相同但地址变了，或换了设备：必须重建，不能复用旧 socket
    disconnect()
  }

  const url = nextUrl
  if (typeof url !== 'string' || url.length === 0) {
    // 没有 endpoint 说明还没配对成功（或配对信息丢了）。
    // 这里不抛错：让首页显示"需要重新配对"，比白屏好。
    updateDevice(device.deviceId, { conn: 'needs-auth' })
    return undefined
  }

  // 令牌按 deviceId 存在本地。取不到就按未认证连接——此时只能走配对流程。
  let token: string | undefined
  try {
    const stored = uni.getStorageSync(`dsh-link/token/${device.deviceId}`)
    if (typeof stored === 'string' && stored.length > 0) token = stored
  } catch {
    // 存储不可用：当作没有令牌，用户需要重新配对
  }

  // 用户主动连接（含点"重新连接"）→ 恢复自动重连
  manualClose = false

  const link = new Link({
    url,
    kind: device.endpoint?.kind ?? 'lan',
    ...(token === undefined ? {} : { token }),
  })
  attached = { deviceId: device.deviceId, url, link }

  link.onStatusChange((status) => {
    const conn: DeviceCard['conn'] =
      status === 'online' ? 'online' : status === 'connecting' ? 'connecting' : status === 'needs-auth' ? 'needs-auth' : 'offline'
    updateDevice(device.deviceId, { conn })

    /*
     * 断线自动重连。
     *
     * 之前状态只是显示，掉线后就永久停在"离线"——手机锁屏、切后台、
     * Wi-Fi 换蜂窝，任何一次都会让用户以为"这个 App 连不上"。
     *
     * 退避：1s → 2s → 4s → 8s → 16s → 30s 封顶。
     * 只在**用户没有主动断开**且仍是当前设备时重试，避免手动断开后又自己连回来。
     */
    if (status === 'offline' && !manualClose) scheduleReconnect(device)
    if (status === 'online') {
      retry = 0
      if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined }
    }
  })

  // 会话事件：统一入口，按方法名分发给当前注册的监听器。
  // 不断开时也保持注册，页面切回来时 listener 已经是新的那个。
  link.on('session.trace', (payload, ch) => sessionListener?.('session.trace', payload, ch))
  link.on('session.stream', (payload, ch) => sessionListener?.('session.stream', payload, ch))
  link.on('approval.request', (payload) => sessionListener?.('approval.request', payload))
  link.on('lock.changed', (payload) => sessionListener?.('lock.changed', payload))

  /*
   * 状态实时同步。
   *
   * 之前这些状态只有"打开页面那一刻"是对的：设备在线/离线、会话在跑/空闲
   * 全靠 refreshAll 拉列表。用户在列表页看着，电脑上跑完了他也不知道。
   *
   * 现在宿主在轮次边界与设备变化时广播，这里直接改 store（不经过页面），
   * 任何正在看列表的页面都会立刻重渲染。
   */
  link.on('session.status', (payload) => {
    const p = payload as { sessionId?: unknown; running?: unknown } | undefined
    const id = typeof p?.sessionId === 'string' ? p.sessionId : ''
    if (id.length === 0) return
    const next = p?.running === true ? 'running' : 'done'
    const row = state.sessions.find((x) => x.id === id)
    if (row !== undefined && row.status !== next) {
      // SessionRow 的字段是只读的，就地替换这一条
      const idx = state.sessions.findIndex((x) => x.id === id)
      if (idx >= 0) {
        const cur = state.sessions[idx]
        if (cur !== undefined) state.sessions[idx] = { ...cur, status: next, updatedAt: Date.now() }
      }
    }
  })

  link.on('device.changed', () => {
    // 设备表可能新增/撤销：拉一次最新的（这条事件本身不带完整设备信息）
    void refreshAll()
  })

  link.connect()
  return link
}

export function disconnect(): void {
  attached?.link.close()
  attached = undefined
}

/** 对话页进出时注册/取消会话事件监听。 */
export function setSessionListener(
  listener: ((method: string, payload: unknown, channel?: string) => void) | undefined,
): void {
  sessionListener = listener
}

/** 更新设备卡（不新建对象，store 是 reactive 的）。 */
function updateDevice(deviceId: string, patch: Partial<DeviceCard>): void {
  const index = state.devices.findIndex((d) => d.deviceId === deviceId)
  if (index < 0) return
  const current = state.devices[index]
  if (current === undefined) return
  state.devices[index] = { ...current, ...patch }
}

/** 用真实 device.list / workspace.list / session.list 刷新 store；失败时保留旧值。 */
export async function refreshAll(): Promise<{ ok: boolean; error?: string }> {
  const link = currentLink()
  if (link === undefined) return { ok: false, error: '尚未连接主机' }

  try {
    const devices = await link.call<{ devices: DeviceCard[] }>('device.list')
    if (Array.isArray(devices?.devices)) {
      /**
       * 合并真实设备列表。
       *
       * 这里踩过一个很隐蔽的坑：之前是
       *   state.devices = list.map(d => ({ ...d, endpoint: endpoints.get(d.deviceId) }))
       * 而配对时建的临时设备 id 是 `tmp_xxx`，真实 id 是 `dev_xxx`——
       * `endpoints.get()` 必然 undefined，临时设备又没被删掉，
       * 结果就是**两条设备并存、都点不开**。
       *
       * 正确做法：
       *   1. 以 deviceId 为键合并
       *   2. 临时设备（tmp_*）一旦拿到真实设备就删除
       *   3. endpoint 按 deviceId 精确匹配；匹配不到就按"当前连接用的那个"补
       */
      const old = new Map(state.devices.map((d) => [d.deviceId, d]))
      const currentUrl = attached?.url

      state.devices = devices.devices.map((d) => {
        const prev = old.get(d.deviceId)
        return {
          ...d,
          conn: 'online' as const,
          // 优先用同一 deviceId 的旧 endpoint；否则若这是当前连接的那台，用当前地址
          endpoint: prev?.endpoint ?? (currentUrl === undefined ? undefined : { url: currentUrl, kind: 'lan' as const }),
          lock: prev?.lock,
          runningCount: prev?.runningCount,
          sessionCount: prev?.sessionCount,
        }
      })

      // 真实列表里没有的临时设备 = 配对未完成或已失效，直接丢掉
      const realIds = new Set(state.devices.map((d) => d.deviceId))
      if (realIds.size > 0) {
        state.devices = state.devices.filter((d) => !d.deviceId.startsWith('tmp_'))
      }

      // activeId 指向的临时设备没了，切到第一台真实设备
      if (!state.devices.some((d) => d.deviceId === state.activeId)) {
        state.activeId = state.devices[0]?.deviceId ?? ''
      }
    }

    const workspaces = await link.call<{ workspaces: WorkspaceRow[] }>('workspace.list')
    state.workspaces = Array.isArray(workspaces?.workspaces) ? workspaces.workspaces : []

    const sessions = await link.call<{ sessions: SessionRow[] }>('session.list')
    // 打上归属设备：移除设备时要按它清会话
    const hostId = attached?.deviceId ?? state.activeId
    state.sessions = (Array.isArray(sessions?.sessions) ? sessions.sessions : []).map((x) => ({ ...x, hostId }))

    state.waiting = state.sessions.filter((s) => s.status === 'waiting-approval').length +
      state.sessions.filter((s) => s.status === 'waiting-input').length
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}
