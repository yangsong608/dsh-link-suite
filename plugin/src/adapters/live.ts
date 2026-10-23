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
  /**
   * 读取历史快照并推给某条连接。
   *
   * 这是"对话页没有历史"的修复：只订阅实时事件是不够的，
   * 进来时必须先拿到已发生的消息。dsh 的 follow 首帧就是 snapshot。
   */
  pushHistory(sessionId: string, connId: string): Promise<{ pushed: number; hasMore: boolean }>
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
  /**
   * 每个会话最近一条 tool/call 的工具名与目标。
   *
   * 用途：dsh 的 tool/result 事件**不带 callId 也不带工具名**
   * （SessionEventMap 里只有 turn/step/message/error/meta），
   * 客户端无法凭 id 配对。会话日志是串行的——一次工具跑完才有下一条——
   * 所以 result 归到"最近的那条 call"是安全的。
   *
   * 并发工具调用（同一 step 多个 call 并发）会退化：result 都归到最近一条。
   * 这是已知限制，比显示一串空的 "tool" 好得多。
   */
  const lastToolCall = new Map<string, { tool: string; target?: string }>()

  /**
   * 给 tool/result 补上工具名与目标。
   *
   * 返回的对象仍是一条 tool 条目，但带上 `callId` 之外的 `mergePrev` 语义：
   * tool 名与 target 从最近的 call 继承，客户端据此把它合并到上一行。
   */
  function enrichToolResult(item: TraceItem, sessionId: string): TraceItem {
    if (item.k !== 'tool') return item

    // call 帧：记住它，供后续 result 继承
    if (typeof item.tool === 'string' && item.tool.length > 0 && item.output === undefined) {
      lastToolCall.set(sessionId, {
        tool: item.tool,
        ...(item.target === undefined ? {} : { target: item.target }),
      })
      return item
    }

    // result 帧：工具名空 = 这是结果，补上最近的 call 信息
    if (item.tool.length === 0) {
      const prev = lastToolCall.get(sessionId)
      if (prev !== undefined) {
        return {
          ...item,
          tool: prev.tool,
          ...(item.target === undefined && prev.target !== undefined ? { target: prev.target } : {}),
        }
      }
    }
    return item
  }

  /*
   * 会话状态广播（不属于任何订阅）。
   *
   * 之前只有 trace/stream 走订阅推送，**会话的"在跑/空闲"完全靠客户端
   * 自己刷新列表**。用户在手机上看列表时，电脑上跑完了他也不知道。
   * 这里在轮次边界向所有已认证连接广播一条极小的状态帧。
   */
  deps.ctx.on('session/event', (session: unknown, event: unknown) => {
    const hostSession = session as { id?: unknown } | undefined
    const sessionId = typeof hostSession?.id === 'string' ? hostSession.id : undefined
    const type = (event as { type?: unknown } | undefined)?.type
    if (sessionId === undefined) return
    if (type === 'turn/start' || type === 'turn/end') {
      deps.broadcast('session.status', {
        sessionId,
        running: type === 'turn/start',
        at: Date.now(),
      })
    }
  })

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
      /*
       * tool/result 在 dsh 的事件结构里**不带 callId**
       * （见 core/session 的 SessionEventMap：{ turn, step, message, error?, meta? }），
       * 所以客户端无法用 id 配对 call 与 result，只能按"紧跟在某条 call 之后的 result"
       * 来归并。
       *
       * 这里在**服务端**把 result 的 tool 名与 target 从最近的同 step call 里补上，
       * 客户端据此原地更新那一行，而不是再插一条空行。
       * 放在服务端做的理由：会话事件是全局单流，这里天然知道顺序；
       * 客户端可能因断线重连丢失上下文。
       */
      const enriched = enrichToolResult(item, sessionId)
      deps.sendEvent(sub.connId, `sess:${sessionId}`, 'session.trace', enriched)
      const stream = toStreamItem(enriched)
      if (stream !== undefined) {
        deps.sendEvent(sub.connId, `sess:${sessionId}`, 'session.stream', stream)
      }
    }
  })

  return {
    open(sessionId, connId, deviceId) {
      const perSession = subs.get(sessionId) ?? new Set<Subscription>()
      for (const existing of perSession) {
        if (existing.connId === connId) {
          /*
           * 已经订阅 → 视为成功。
           *
           * 原来返回 false，而 router 把 false 当"会话不存在"抛错，
           * 结果**第二次进入同一个会话时 follow 直接失败**，历史一条都拿不到
           * （用户看到的就是"第一次有历史，退出再进就没了"）。
           * 幂等语义应该是"你要的状态已经达成"，不是错误。
           */
          return true
        }
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

    async pushHistory(sessionId, connId) {
      const sessions = deps.ctx.get<{
        follow?: (request: Record<string, unknown>, signal: AbortSignal) => AsyncIterable<unknown>
      }>('sessionController', false)
      if (sessions?.follow === undefined) return { pushed: 0, hasMore: false }

      const controller = new AbortController()
      // 只要首帧（snapshot），拿到就断开——不要留一个长订阅在这里
      const timer = setTimeout(() => controller.abort(), 6000)
      timer.unref?.()

      let pushed = 0
      let hasMore = false
      try {
        for await (const frame of sessions.follow(
          { address: { kind: 'session', sessionId }, maxMessages: 50 },
          controller.signal,
        )) {
          const f = frame as {
            type?: string
            cursor?: number
            records?: readonly { event?: { type?: string; seq?: number; time?: number; data?: unknown } }[]
            hasMore?: boolean
            header?: unknown
          }
          // 首帧是 snapshot：含历史 records、cursor、hasMore
          if (f.type !== 'snapshot') break

          hasMore = f.hasMore === true
          const state = deps.lock.get()
          const redacted = state.soft && !state.locked

          for (const record of f.records ?? []) {
            const ev = record.event
            if (ev?.seq === undefined || typeof ev.type !== 'string') continue
            const item = toTraceItem(
              { type: ev.type, seq: ev.seq, at: ev.time, data: (ev.data ?? {}) as Record<string, unknown> },
              redacted,
            )
            if (item === undefined) continue
            // 历史回放同样要补 result 的工具名：dsh 的 tool/result 不带它
            const enriched = enrichToolResult(item, sessionId)
            deps.sendEvent(connId, `sess:${sessionId}`, 'session.trace', enriched)
            const stream = toStreamItem(enriched)
            if (stream !== undefined) {
              deps.sendEvent(connId, `sess:${sessionId}`, 'session.stream', { ...stream, history: true })
            }
            pushed += 1
          }

          // 告诉客户端"历史到此为止、后面是新事件"，避免它把两者混在一起排序
          deps.sendEvent(connId, `sess:${sessionId}`, 'session.history.end', {
            cursor: f.cursor ?? 0,
            hasMore,
            pushed,
          })
          break
        }
      } catch (error) {
        deps.ctx.logger?.warn('[dsh-link] 读取历史失败：%s', error instanceof Error ? error.message : String(error))
        deps.sendEvent(connId, `sess:${sessionId}`, 'session.history.end', { cursor: 0, hasMore: false, pushed, error: true })
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
      return { pushed, hasMore }
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
