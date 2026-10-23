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
let sessionListener: ((method: string, payload: unknown) => void) | undefined

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
  })

  // 会话事件：统一入口，按方法名分发给当前注册的监听器。
  // 不断开时也保持注册，页面切回来时 listener 已经是新的那个。
  link.on('session.trace', (payload) => sessionListener?.('session.trace', payload))
  link.on('session.stream', (payload) => sessionListener?.('session.stream', payload))
  link.on('approval.request', (payload) => sessionListener?.('approval.request', payload))
  link.on('lock.changed', (payload) => sessionListener?.('lock.changed', payload))

  link.connect()
  return link
}

export function disconnect(): void {
  attached?.link.close()
  attached = undefined
}

/** 对话页进出时注册/取消会话事件监听。 */
export function setSessionListener(listener: ((method: string, payload: unknown) => void) | undefined): void {
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
      // 保留本机缓存的 endpoint（宿主不下发连接地址，那是客户端的事）
      const endpoints = new Map(state.devices.map((d) => [d.deviceId, d.endpoint]))
      state.devices = devices.devices.map((d) => ({
        ...d,
        conn: 'online',
        endpoint: endpoints.get(d.deviceId),
      }))
    }

    const workspaces = await link.call<{ workspaces: WorkspaceRow[] }>('workspace.list')
    state.workspaces = Array.isArray(workspaces?.workspaces) ? workspaces.workspaces : []

    const sessions = await link.call<{ sessions: SessionRow[] }>('session.list')
    state.sessions = Array.isArray(sessions?.sessions) ? sessions.sessions : []

    state.waiting = state.sessions.filter((s) => s.status === 'waiting-approval').length +
      state.sessions.filter((s) => s.status === 'waiting-input').length
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}
