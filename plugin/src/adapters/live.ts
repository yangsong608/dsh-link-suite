/**
 * 会话事件订阅 + 审批应答。
 *
 * 两块能力都挂在**同一份 dsh 事件源**上：
 *   - 订阅：`ctx.on('session/event')` → 归一化 → 推给正在 follow 该会话的连接
 *   - 审批：`ctx.on('approval/request')` → 广播给设备 → 等手机回应 → 交回 dsh
 *
 * 为什么审批必须实现成 answerer 而不是"查某个服务的方法"：
 * dsh 的审批链是 `ctx.waterfall(..., 'approval/request', ...)`，返回值就是决策。
 * 只有作为链条上的一环才能把手机上的点击变成真正的批准，没有第二个入口。
 */

import { randomUUID } from 'node:crypto'

import type { TraceItem } from '@dsh-link/protocol'

import type { DshContext } from '../dsh.js'
import type { LockService } from '../lock/index.js'
import { toTraceItem, toStreamItem, type HostSessionEvent } from '../adapters/sessions.js'

/** 一条打开的 follow 订阅。 */
interface Subscription {
  readonly sessionId: string
  readonly connId: string
  readonly deviceId: string
  close(): void
}

export interface SubscriptionHub {
  /** 打开订阅；返回 false 表示同一连接已经订阅过同一会话（幂等，不算错误）。 */
  open(sessionId: string, connId: string, deviceId: string): boolean
  /** 连接断开时清掉它的全部订阅。 */
  closeConn(connId: string): void
  dispose(): void
  readonly size: number
}

export interface ApprovalBridge {
  settle(id: string, outcome: 'allowed-once' | 'rejected', deviceId: string): boolean
  pending(): { id: string; tool: string; reason?: string; at: number }[]
  dispose(): void
  readonly size: number
}

export interface Deps {
  readonly ctx: DshContext
  readonly lock: LockService
  /** 向某条连接推一帧 evt。由网关提供。 */
  readonly sendEvent: (connId: string, channel: string, method: string, payload: unknown) => void
  /** 向所有已认证连接广播。 */
  readonly broadcast: (method: string, payload: unknown) => void
  /** 某条连接属于哪台设备（用于审批归属校验）。 */
  readonly deviceOf: (connId: string) => string | undefined
  /** 当前已认证连接数。为 0 时审批不该等远程回答。 */
  readonly authenticatedConnections: number
}

/**
 * 订阅中心。
 *
 * 会话事件是**全局一条流**（ctx.on('session/event')），订阅是"过滤 + 分发"。
 * 不在每个 follow 里各注册一个监听器：那样 N 个手机就 N 份解析，
 * 而且重复注册的清理逻辑会让断开路径变成 bug 温床。
 */
export function createSubscriptionHub(deps: Deps): SubscriptionHub {
  const subs = new Map<string, Set<Subscription>>() // sessionId -> subs
  const byConn = new Map<string, Set<string>>() // connId -> sessionIds

  // 会话事件 → trace → 每个订阅者
  deps.ctx.on('session/event', (session: unknown, event: unknown) => {
    const hostSession = session as { id?: unknown } | undefined
    const sessionId = typeof hostSession?.id === 'string' ? hostSession.id : undefined
    if (sessionId === undefined) return
    const watchers = subs.get(sessionId)
    if (watchers === undefined || watchers.size === 0) return

    const state = deps.lock.get()
    // 半锁时正文类字段清空（条目级裁剪，不靠方法级 guard）
    const redacted = state.soft && !state.locked
    const item = toTraceItem(event as HostSessionEvent, redacted)
    if (item === undefined) return

    for (const sub of watchers) {
      // trace 帧给"执行过程"页；stream 帧给聊天页。同一条事件推两种投影，
      // 由 App 决定渲染哪个——服务端不做"猜用户在看哪个页面"。
      deps.sendEvent(sub.connId, `sess:${sessionId}`, 'session.trace', item satisfies TraceItem)
      const stream = toStreamItem(item)
      if (stream !== undefined) {
        deps.sendEvent(sub.connId, `sess:${sessionId}`, 'session.stream', stream)
      }
    }
  })

  return {
    open(sessionId, connId, deviceId) {
      const perSession = subs.get(sessionId) ?? new Set<Subscription>()
      for (const existing of perSession) {
        if (existing.connId === connId) return false // 已经订阅，幂等
      }
      const subscription: Subscription = {
        sessionId,
        connId,
        deviceId,
        close() {
          subs.get(sessionId)?.delete(subscription)
          byConn.get(connId)?.delete(sessionId)
        },
      }
      perSession.add(subscription)
      subs.set(sessionId, perSession)
      const connSet = byConn.get(connId) ?? new Set<string>()
      connSet.add(sessionId)
      byConn.set(connId, connSet)
      return true
    },

    closeConn(connId) {
      const sessionIds = byConn.get(connId)
      if (sessionIds === undefined) return
      for (const sessionId of sessionIds) {
        const perSession = subs.get(sessionId)
        if (perSession === undefined) continue
        for (const sub of [...perSession]) {
          if (sub.connId === connId) perSession.delete(sub)
        }
        if (perSession.size === 0) subs.delete(sessionId)
      }
      byConn.delete(connId)
    },

    dispose() {
      subs.clear()
      byConn.clear()
    },

    get size() {
      return [...subs.values()].reduce((sum, set) => sum + set.size, 0)
    },
  }
}

/**
 * 审批桥。
 *
 * 关键点：
 *   1. 只接管**已配对设备**发起场景；没有在线设备时直接 `next()` 交回 dsh，
 *      让本机 UI 自己处理——绝不能因为手机不在线就把审批卡死。
 *   2. 超时（默认 60s）返回 'cancelled'，而不是 'rejected'：用户没答 ≠ 用户拒绝。
 *   3. 归属校验：只有当初被问的那条连接所在设备能应答。
 */
export function createApprovalBridge(deps: Deps, timeoutMs = 60_000): ApprovalBridge {
  interface Pending {
    readonly id: string
    readonly tool: string
    readonly reason?: string
    readonly at: number
    readonly resolve: (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void
    readonly timer: ReturnType<typeof setTimeout>
  }
  const pending = new Map<string, Pending>()

  deps.ctx.on('approval/request', (request: unknown, next: () => Promise<unknown>) => {
    const req = request as {
      agent?: unknown
      toolName?: string
      reason?: string
      callId?: string
      signal?: AbortSignal
    }
    const tool = typeof req.toolName === 'string' && req.toolName.length > 0 ? req.toolName : 'tool'

    // 锁定态不做远程审批：锁死时连"要不要批准"都不该由远端回答。
    const state = deps.lock.get()
    if (state.locked) return next()

    // 没有任何已认证连接时直接交回 dsh：让本机 UI 自己处理，
    // 而不是让本地流程等一个不存在的远程回答 60 秒。
    if (deps.authenticatedConnections <= 0) return next()

    const id = randomUUID()
    const decision = new Promise<'allowed-once' | 'rejected' | 'cancelled'>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        // 超时返回 cancelled 而不是 rejected：用户没答 ≠ 用户拒绝。
        resolve('cancelled')
      }, timeoutMs)
      timer.unref?.()

      pending.set(id, {
        id,
        tool,
        ...(typeof req.reason === 'string' ? { reason: req.reason } : {}),
        at: Date.now(),
        resolve,
        timer,
      })

      deps.broadcast('approval.request', {
        id,
        tool,
        ...(typeof req.reason === 'string' ? { reason: req.reason } : {}),
        at: Date.now(),
        timeoutMs,
      })
    })

    return decision.then((outcome) => {
      const entry = pending.get(id)
      if (entry !== undefined) {
        clearTimeout(entry.timer)
        pending.delete(id)
      }
      // 'cancelled' 交回 next() 让 dsh 按自己的策略处理，比伪造一个 rejected 更诚实
      return outcome === 'cancelled' ? next() : outcome
    })
  })

  return {
    settle(id, outcome, deviceId) {
      const entry = pending.get(id)
      if (entry === undefined) return false
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.resolve(outcome)
      deps.ctx.logger?.info('[dsh-link] 审批 %s 由 %s 决定：%s', id, deviceId, outcome)
      return true
    },
    pending() {
      return [...pending.values()].map((p) => ({
        id: p.id,
        tool: p.tool,
        ...(p.reason === undefined ? {} : { reason: p.reason }),
        at: p.at,
      }))
    },
    dispose() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.resolve('cancelled')
      }
      pending.clear()
    },
    get size() {
      return pending.size
    },
  }
}
