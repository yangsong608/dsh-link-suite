/**
 * 路由表：方法名 → 实现。
 *
 * 只登记**实现存在**的方法。没实现的落在 `notImplemented` 上，返回
 * `host/unavailable` 而不是 500 —— App 据此显示"这台机器暂不支持"，而不是"出错了"。
 *
 * 这里一律通过 `ctx.get(name, false)` 软读 dsh 服务：
 * 严格代理下直接 `ctx.sessionController` 会抛错，即使服务不存在也一样。
 */

import { randomUUID } from 'node:crypto'

import { encodePairUri, encodeQr, pairPayloadFromEndpoint } from '@dsh-link/protocol'

import { RpcError, DEFAULT_CAPS, METHOD_POLICY, type DeviceRole, type Method } from '@dsh-link/protocol'
import type { DshContext, SessionController, PluginManager, WorkspaceRegistry, WorkspaceController } from '../dsh.js'
import type { LinkConfig } from '../config.js'
import type { LockService } from '../lock/index.js'
import type { DeviceRegistry } from './devices.js'
import { buildChanges, latestDiffForPath } from '../adapters/changes.js'
import { toSessionSummaries, type HostSessionSummary } from '../adapters/sessions.js'

/** 软读会话服务；宿主没装会话能力时返回 undefined，由 handler 决定怎么降级。 */
function sessionsOf(ctx: DshContext): SessionController | undefined {
  return ctx.get<SessionController>('sessionController', false)
}

export interface CallMeta {
  readonly deviceId: string
  /** 配对时记录的展示名（"iPhone 15"）。未配对连接为 undefined。 */
  readonly label?: string
  readonly role: keyof typeof ROLE_ORDER
  readonly remoteAddress: string
  /** 当前连接 id，pair.finish 用它把连接升格为已认证。 */
  readonly connId: string
}

export const ROLE_ORDER = { viewer: 0, operator: 1, approver: 2, admin: 3 } as const

export interface RouteContext {
  readonly ctx: DshContext
  readonly cfg: LinkConfig
  readonly lock: LockService
  readonly devices: DeviceRegistry
  readonly hostId: string
  readonly dshVersion: string
  /** 手机可用的连接地址（中继优先，其次各网卡）。配对时下发给客户端。 */
  readonly endpoints: readonly string[]
  /**
   * 网关自身的引用。只在 plugin apply() 里晚绑定一次：
   * gateway 需要 handlers，handlers 又需要 gateway（pair.finish 要升格连接），
   * 用 getter 打破这个循环，而不是引入可变全局。
   */
  readonly gateway: () =>
    | {
        authenticate(connId: string, deviceId: string, role: DeviceRole, label: string): boolean
        disconnectDevice(deviceId: string): number
        /** 向所有已认证连接广播（状态同步用）。 */
        broadcast(method: string, payload: unknown): void
        /** 当前在线的设备 id。 */
        onlineDeviceIds(): readonly string[]
      }
    | undefined
  /** 会话事件订阅表（follow 打开后由 server 推帧）。M1 可缺省。 */
  readonly subscriptions?: {
    open(sessionId: string, connId: string): boolean
    /** 回放历史（订阅时立刻调用，否则对话页是空的）。 */
    pushHistory?(sessionId: string, connId: string): Promise<{ pushed: number; hasMore: boolean }>
  }
  /** 待处理审批表（PC 触发、手机应答）。M1 可缺省。 */
  readonly approvals?: {
    settle(id: string, outcome: 'allowed-once' | 'rejected', deviceId: string): boolean
  }
}

export type Handler = (rc: RouteContext, params: Record<string, unknown>, meta: CallMeta) => Promise<unknown>

/** 完整的方法表。类型是 `Record<Method, Handler>`，漏一个方法编译期就红。 */
export type GatewayHandlers = Record<Method, Handler>

const notImplemented =
  (method: Method): Handler =>
  async () => {
    throw new RpcError('host/unavailable', `${method} 在当前版本尚未实现`)
  }

const str = (params: Record<string, unknown>, key: string): string => {
  const v = params[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new RpcError('rpc/bad-args', `参数 ${key} 必须是非空字符串`)
  }
  return v
}

export function createHandlers(): GatewayHandlers {
  const handlers = {
    // ── 设备与连接 ────────────────────────────────────────────────────────
    'device.info': async (rc) => ({
      hostId: rc.hostId,
      name: rc.cfg.gateway.bind === 'lan' ? 'MOSS Link (LAN)' : 'MOSS Link (loopback)',
      platform: process.platform,
      dshVersion: rc.dshVersion,
      linkVersion: '0.1.0',
      // caps 从协议默认值来，并在这里按实际能力覆盖：
      // 没装 git 就别宣称支持仓库浏览（App 会据此隐藏入口，而不是点进去才报错）
      caps: { ...DEFAULT_CAPS, gh: rc.cfg.repo.github.enabled ? 1 : 0 },
      lock: rc.lock.get(),
    }),

    // ── 锁屏（4 个方法，全部豁免，锁死也必须可达）────────────────────────
    'lock.status': async (rc) => rc.lock.get(),

    'lock.unlock': async (rc, p, meta) => {
      const password = str(p, 'password')
      try {
        return rc.lock.unlock(password, 'device', meta.deviceId)
      } catch (e) {
        const err = e as { code?: string; message?: string; details?: Record<string, unknown> }
        // UnlockError → RpcError：错误码是我们自己定义的字符串，这里收窄到协议枚举
        const code = err.code === 'lock/bad-password' || err.code === 'lock/rate-limited'
          ? err.code
          : 'lock/no-password-set'
        throw new RpcError(code, err.message ?? '解锁失败', err.details)
      }
    },

    'lock.request': async (rc, _p, meta) => {
      // 语义：本机允许"已配对设备直接输密码解锁"时，不该再走远程审批这条路——
      // 那条路的前提是设备自己没法解。原实现条件写对了但文案与错误码都反了
      //（条件是"允许"，文案却说"不允许"，错误码还是 no-password-set），
      // 手机端会显示成"未设置密码"，用户完全没法据此行动。
      if (rc.cfg.lock.allowDeviceUnlock) {
        throw new RpcError('lock/use-password', '本机允许已配对设备直接输密码解锁，请使用密码')
      }
      const ok = await rc.lock.requestRemote(meta.deviceId, meta.label ?? meta.deviceId)
      if (!ok) throw new RpcError('lock/request-timeout', '主机未在 30 秒内确认')
      return { unlocked: true }
    },

    'lock.lock': async (rc) => {
      rc.lock.lock('remote')
      return rc.lock.get()
    },

    // ── 配对与设备 ────────────────────────────────────────────────────────
    // pair.* 是预认证方法：未配对设备也要能调，否则配对流程死锁。
    'pair.start': async (rc) => {
      // 手机自助发起的配对**不**预批准：必须在 PC 上点一次确认。
      // 否则任何能连上端口的人都能给自己发一个码并配对成功。
      const session = rc.devices.startPair(rc.cfg.gateway.pairTtlMs, false)
      rc.ctx.logger?.info('[dsh-link] 待配对：%s（%ds 内有效）', session.code, Math.round(rc.cfg.gateway.pairTtlMs / 1000))
      // 连地址一起给：App 自己不知道宿主监听在哪（尤其有多网卡或走中继时）。
      // 只回一个码等于让用户自己去查 IP 手抄——那是把宿主能做的工作推给用户。
      const fingerprint = rc.hostId.slice(-6)
      const candidates = rc.endpoints
        .map((wsUrl) => {
          const payload = pairPayloadFromEndpoint(wsUrl, session.code, fingerprint)
          if (payload === undefined) return undefined
          const uri = encodePairUri(payload)
          return { wsUrl, uri, qr: encodeQr(uri) }
        })
        .filter((c): c is NonNullable<typeof c> => c !== undefined)

      return {
        code: session.code,
        expiresAt: session.expiresAt,
        hostId: rc.hostId,
        // 指纹给用户比对"这台机器确实是它"，不做信任决策
        fingerprint,
        // 首选地址与二维码。多网卡时手机连不上就换 candidates 里的下一个。
        wsUrl: candidates[0]?.wsUrl,
        candidates: candidates.map((c) => ({ wsUrl: c.wsUrl, uri: c.uri })),
        qr: candidates[0]?.qr,
        // 手机自助发起的配对必须等 PC 确认
        next: 'ask-owner',
      }
    },

    'pair.finish': async (rc, p, meta) => {
      const code = str(p, 'code')
      const label = typeof p['label'] === 'string' && p['label'].length > 0 ? p['label'] : '未命名设备'
      const platform = typeof p['platform'] === 'string' && p['platform'].length > 0 ? p['platform'] : 'unknown'

      const outcome = await rc.devices.finishPair({ code, label, platform })
      if (!outcome.ok) {
        const codeMap = {
          'unknown-code': 'auth/need-pair',
          expired: 'auth/expired',
          'not-approved': 'auth/forbidden',
          consumed: 'auth/expired',
        } as const
        const message = {
          'unknown-code': '配对码不存在',
          expired: '配对码已过期，请在电脑上重新生成',
          'not-approved': '这台电脑还没有确认配对',
          consumed: '配对码已被使用',
        }[outcome.reason]
        throw new RpcError(codeMap[outcome.reason], message)
      }

      const { device, token } = outcome.result
      // 关键一步：把当前连接升格为已认证。没有这句，设备拿到了令牌
      // 却仍然每条调用都被 auth/need-pair 拒掉。
      const upgraded = rc.gateway()?.authenticate(meta.connId, device.deviceId, device.role, device.label) ?? false
      if (!upgraded) throw new RpcError('host/internal', '连接已断开，请重试配对')

      rc.devices.list() // 触发一次读取，确保记录已可查
      return { deviceId: device.deviceId, role: device.role, label: device.label, token }
    },

    'device.list': async (rc) => {
      /*
       * 每条设备带上 online。
       *
       * 宿主是唯一知道"这台设备此刻有没有连接"的地方；
       * 之前不下发，客户端只能把非当前设备一律当成"状态未知"，
       * 于是列表里其他电脑永远显示成同一个样子。
       */
      const online = new Set(rc.gateway()?.onlineDeviceIds() ?? [])
      return {
        devices: rc.devices.list().map((d) => ({ ...d, online: online.has(d.deviceId) })),
      }
    },

    'device.rename': async (rc, p) => {
      const deviceId = str(p, 'deviceId')
      const label = str(p, 'label').trim()
      if (label.length === 0 || label.length > 32) {
        throw new RpcError('rpc/bad-args', '名称需为 1-32 个字符')
      }
      const done = await rc.devices.rename(deviceId, label)
      if (!done) throw new RpcError('auth/revoked', '设备不存在或已撤销')
      return { ok: true, deviceId, label }
    },

    'device.revoke': async (rc, p) => {
      const deviceId = str(p, 'deviceId')
      const revoked = await rc.devices.revoke(deviceId)
      if (revoked === undefined) throw new RpcError('auth/revoked', '设备不存在或已撤销')
      // 表里删了但 socket 还活着等于没撤销：必须把在线连接一并断掉
      rc.gateway()?.disconnectDevice(deviceId)
      return { revoked: true, deviceId }
    },

    // ── 工作区 ────────────────────────────────────────────────────────────
    'workspace.list': async (rc) => {
      const registry = rc.ctx.get<WorkspaceRegistry>('workspaceRegistry', false)
      const workspaces = registry?.list?.() ?? []
      return {
        workspaces: workspaces.map((ws) => {
          /**
           * 会话归属从 workspace 反查，不能指望 session 带上 workspaceId：
           * dsh 的 SessionSummary 里没有这个字段，而 Workspace.sessionIds 是
           * 权威来源（见 packages/workspace/workspace/src/types.ts）。
           *
           * sessionIds 之前没返回，导致 App 无法分组——这正是"会话页没有
           * 工作区分组"的根因。
           */
          const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds.map(String) : []
          return {
            id: String(ws.id),
            name: ws.title,
            path: ws.path,
            pinned: false,
            sessionCount: ids.length,
            // 会话 id 列表：App 用它把 session.list 的结果归到各组
            sessionIds: ids,
            updatedAt: Date.parse(ws.createdAt) || Date.now(),
          }
        }),
      }
    },
    'workspace.create': notImplemented('workspace.create'),
    'dir.list': notImplemented('dir.list'),

    // ── 会话主线 ──────────────────────────────────────────────────────────
    'session.list': async (rc, _p, meta) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions === undefined) throw new RpcError('host/unavailable', '宿主没有会话服务')

      const workspaces = rc.ctx.get<WorkspaceRegistry>('workspaceRegistry', false)?.list?.() ?? []
      const workspaceId = workspaces[0] === undefined ? '' : String(workspaces[0].id)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5_000)
      timer.unref?.()
      try {
        const value = (await sessions.list({}, controller.signal)) as { items?: readonly HostSessionSummary[] }
        const items = value?.items ?? []
        // 临时诊断：把 dsh 返回的原始 summary 打出来，确认 title 到底在哪一层
        if (items.length > 0) {
          rc.ctx.logger?.info('[dsh-link] 原始 session summary: %s', JSON.stringify(items[0]))
        }
        return { sessions: toSessionSummaries(items, workspaceId) }
      } finally {
        clearTimeout(timer)
      }
    },

    'session.prompt': async (rc, p, meta) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions === undefined) throw new RpcError('host/unavailable', '宿主没有会话服务')
      const sessionId = str(p, 'sessionId')
      // 只发附件（"把这张图给它看"）是合法操作，所以文字允许为空；
      // 但文字与附件都为空就没意义了。
      const text = typeof p['text'] === 'string' ? p['text'] : ''
      const hasAttach = Array.isArray(p['attachments']) && (p['attachments'] as unknown[]).length > 0
      const hasImage = Array.isArray(p['images']) && (p['images'] as unknown[]).length > 0
      if (text.trim().length === 0 && !hasAttach && !hasImage) {
        throw new RpcError('rpc/bad-args', '消息内容不能为空')
      }

      // requestId 必须由客户端提供并持久化（断线重发时用它去重）。
      // 客户端没给就现造一个——但那样重发可能重复执行，所以文档里要求 App 必须传。
      const requestId = typeof p['requestId'] === 'string' && p['requestId'].length > 0
        ? p['requestId']
        : randomUUID()

      /*
       * 内容块：文字 + 可选附件。
       *   attachments: 上传后拿到的 receiptId（只能在本 Agent 作用域内用）
       *   images:      直接内联的图片（base64），不需要走上传
       * 顺序按"先文字后附件"——agent 读起来更自然。
       */
      const content: Record<string, unknown>[] = [{ type: 'text', text }]
      if (Array.isArray(p['attachments'])) {
        for (const r of p['attachments']) {
          if (typeof r === 'string' && r.length > 0) content.push({ type: 'file', receiptId: r })
        }
      }
      if (Array.isArray(p['images'])) {
        for (const img of p['images']) {
          const item = img as { mediaType?: unknown; data?: unknown }
          if (typeof item?.data === 'string' && item.data.length > 0) {
            content.push({
              type: 'image',
              mediaType: typeof item.mediaType === 'string' ? item.mediaType : 'image/png',
              data: item.data,
            })
          }
        }
      }

      const controller = new AbortController()
      try {
        await sessions.prompt(
          {
            requestId,
            sessionId,
            // steer：用户此刻就想影响正在跑的这一轮。
            // queue 语义留给 session.queue.*。
            mode: 'steer',
            content,
          },
          controller.signal,
        )
        // 成功发送也算活动：避免"人在手机上操作，PC 却因空闲而锁"
        rc.lock.touch()
        return { accepted: true, requestId }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // dsh 在会话忙且不允许 steer 时会抛；映射成 session/busy 让 App 能显示"排队或等待"
        if (/busy|running|inbox/i.test(message)) {
          throw new RpcError('session/busy', '会话正在运行中，请稍后再试或使用队列')
        }
        throw new RpcError('host/internal', message)
      }
    },

    'session.cancel': async (rc, p) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions === undefined) throw new RpcError('host/unavailable', '宿主没有会话服务')
      const sessionId = str(p, 'sessionId')
      await sessions.cancel({ sessionId })
      return { canceled: true }
    },

    // follow 是长连接：注册在当前连接的订阅表里，由 server 的心跳与断开清理负责收尾。
    // 这里只返回订阅凭证，后续帧走 evt 通道 `sess:<id>`。
    'session.follow': async (rc, p, meta) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions === undefined) throw new RpcError('host/unavailable', '宿主没有会话服务')
      const sessionId = str(p, 'sessionId')
      const opened = rc.subscriptions?.open(sessionId, meta.connId)
      if (opened === false) throw new RpcError('session/not-found', '会话不存在或无法订阅')

      // 关键：订阅之后**立刻回放历史**。
      // 只推新事件的话，用户进来看到的是空列表——那正是之前"对话页没历史"的原因。
      // 不等它完成就返回：历史通过 evt 帧推送，RPC 只回一个通道名。
      const history = rc.subscriptions?.pushHistory?.(sessionId, meta.connId)
      if (history !== undefined) {
        // 不 await：长会话的历史可能有几千条，阻塞 RPC 会让客户端以为卡住
        void history.catch(() => {
          // pushHistory 内部已处理错误并推送 session.history.end
        })
      }

      return { channel: `sess:${sessionId}`, sessionId }
    },

    'approval.answer': async (rc, p, meta) => {
      const id = str(p, 'id')
      const outcome = p['outcome']
      const approved = outcome === 'allowed-once' || outcome === 'approve' || outcome === true
      const settled = rc.approvals?.settle(id, approved ? 'allowed-once' : 'rejected', meta.deviceId)
      if (settled !== true) throw new RpcError('session/not-found', '审批请求不存在或已过期')
      return { settled: true, outcome: approved ? 'allowed-once' : 'rejected' }
    },

    // ── M2 待实现：执行过程 ───────────────────────────────────────────────
    // 数据源是 dsh 的 session 事件流；`redacted` 裁剪在 handler 里做，
    // 不放在 guard —— guard 只看方法级，裁剪是条目级（见 07 §5.2）。
    'session.trace': notImplemented('session.trace'),
    'session.trace.detail': notImplemented('session.trace.detail'),

    // ── M2 待实现：消息发送队列 ───────────────────────────────────────────
    // 队列是宿主侧内存 + 落盘，不是 dsh 的能力——dsh 一次只接受一条 prompt。

    // ── 消息队列（dsh 里就是 Agent 的 inbox）────────────────────────────
    //
    // dsh **没有**独立的队列服务：所谓发送队列是 agent 的两条持久投影
    //   next-turn（按轮 FIFO）、next-step（下一个 step 边界）
    // 读=session.projections 的 values.inbox；改=session.updateQueue；
    // 入队=session.prompt(mode:'queue')。
    // 刻意不发明 reorder / clear —— dsh 不支持，声明了也只会骗客户端。
    'session.queue.list': async (rc, p) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions?.projections === undefined) throw new RpcError('host/unavailable', '宿主不支持读取队列')
      const sessionId = str(p, 'sessionId')
      const projection = (await sessions.projections({ sessionId })) as {
        values?: { inbox?: Record<string, readonly unknown[]> }
      } | null
      const inbox = projection?.values?.inbox ?? {}
      const shape = (list: readonly unknown[] | undefined): { itemId: string; text: string }[] =>
        (list ?? []).map((raw) => {
          const item = raw as { id?: unknown; content?: readonly { type?: string; text?: string }[] }
          const text = (item.content ?? [])
            .filter((c) => c?.type === 'text' && typeof c.text === 'string')
            .map((c) => String(c.text))
            .join('\n')
          return { itemId: String(item.id ?? ''), text }
        })
      return {
        nextTurn: shape(inbox['next-turn']),
        nextStep: shape(inbox['next-step']),
      }
    },

    'session.queue.push': async (rc, p) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions === undefined) throw new RpcError('host/unavailable', '宿主没有会话服务')
      const sessionId = str(p, 'sessionId')
      const text = str(p, 'text')
      if (text.trim().length === 0) throw new RpcError('rpc/bad-args', '内容不能为空')
      // agent 运行中不会拒绝，而是排到 next-turn，每轮消费一条
      const requestId = typeof p['requestId'] === 'string' && p['requestId'].length > 0 ? p['requestId'] : randomUUID()
      const content: Record<string, unknown>[] = [{ type: 'text', text }]
      if (Array.isArray(p['attachments'])) {
        for (const r of p['attachments']) {
          if (typeof r === 'string' && r.length > 0) content.push({ type: 'file', receiptId: r })
        }
      }
      const controller = new AbortController()
      try {
        await sessions.prompt(
          { requestId, sessionId, mode: 'queue', content },
          controller.signal,
        )
        return { ok: true }
      } catch (error) {
        throw new RpcError('host/internal', error instanceof Error ? error.message : String(error))
      }
    },

    'session.queue.edit': async (rc, p) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions?.updateQueue === undefined) throw new RpcError('host/unavailable', '宿主不支持修改队列')
      const sessionId = str(p, 'sessionId')
      const itemId = str(p, 'itemId')
      const text = str(p, 'text')
      if (text.trim().length === 0) throw new RpcError('rpc/bad-args', '内容不能为空')
      try {
        // edit 只接受非空纯文本块
        await sessions.updateQueue({ sessionId, itemId, action: { kind: 'edit', content: [{ type: 'text', text }] } })
        return { ok: true }
      } catch (error) {
        throw queueError(error)
      }
    },

    'session.queue.remove': async (rc, p) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions?.updateQueue === undefined) throw new RpcError('host/unavailable', '宿主不支持修改队列')
      const sessionId = str(p, 'sessionId')
      const itemId = str(p, 'itemId')
      try {
        await sessions.updateQueue({ sessionId, itemId, action: { kind: 'remove' } })
        return { ok: true }
      } catch (error) {
        throw queueError(error)
      }
    },

    'session.queue.steer': async (rc, p) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions?.updateQueue === undefined) throw new RpcError('host/unavailable', '宿主不支持 steer')
      const sessionId = str(p, 'sessionId')
      const itemId = str(p, 'itemId')
      try {
        // 把排队项提到当前轮的下一步；要求 agent 正在跑
        await sessions.updateQueue({ sessionId, itemId, action: { kind: 'steer' } })
        return { ok: true }
      } catch (error) {
        throw queueError(error)
      }
    },

    // ── 附件上传 ──────────────────────────────────────────────────────────
    //
    // dsh 的上传是 `ctx.fileUploads.uploadStream({ sessionId, data, name })`：
    // 它内部按 sessionId 解析 Agent，落到 Agent 的暂存区，返回
    // `{ receiptId, file }`。receiptId 只在**同一个 Agent 作用域**内有效，
    // 随后的 prompt 用 `{ type:'file', receiptId }` 引用它。
    //
    // 为什么不用 `@Remote('upload')`：那个签名要 Agent 实例（由 remote 框架
    // 从 scope 注入），我们这边拿不到；uploadStream 是同一实现的稳定入口。
    'fs.upload': async (rc, p) => {
      const uploads = rc.ctx.get<FileUploadsService>('fileUploads', false)
      if (uploads?.uploadStream === undefined) {
        throw new RpcError('host/unavailable', '宿主不支持附件上传')
      }
      const sessionId = str(p, 'sessionId')
      const name = typeof p['name'] === 'string' ? p['name'] : 'attachment'
      const base64 = str(p, 'data')
      if (base64.length === 0) throw new RpcError('rpc/bad-args', '文件内容为空')

      // base64 → Uint8Array（分块解码：整串 atob 在大文件上会爆栈）
      let bytes: Uint8Array
      try {
        bytes = decodeBase64(base64)
      } catch {
        throw new RpcError('rpc/bad-args', '文件内容不是合法的 base64')
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new RpcError('rpc/bad-args', `单个附件不能超过 ${String(Math.round(MAX_UPLOAD_BYTES / 1024 / 1024))}MB`)
      }

      const controller = new AbortController()
      try {
        const value = (await uploads.uploadStream({
          sessionId,
          name,
          signal: controller.signal,
          // uploadStream 要 AsyncIterable<Uint8Array>
          data: (async function* () { yield bytes })(),
        })) as { receiptId?: unknown; file?: unknown } | undefined
        const receiptId = typeof value?.receiptId === 'string' ? value.receiptId : ''
        if (receiptId.length === 0) throw new RpcError('host/internal', '宿主没有返回上传凭证')
        return {
          receiptId,
          name,
          bytes: bytes.byteLength,
          file: value?.file ?? null,
        }
      } catch (error) {
        if (error instanceof RpcError) throw error
        throw new RpcError('host/internal', error instanceof Error ? error.message : String(error))
      }
    },

    // ── 产物（本轮改了哪些文件）──────────────────────────────────────────
    //
    // dsh 的 changes/diff 是 **owner-only HTTP 路由**（/api/changes.summary|diff），
    // 不是 @Remote，经网关的非 owner Peer 拿不到（403）。
    // 所以这里从持久事件里重建：tool/result 的 meta.diffs 是 {path, oldText, newText}，
    // 由 write / edit 工具写入。
    //
    // 诚实标注：只覆盖文件工具的写入/编辑，不含 shell 产生的变更、二进制文件、
    // 纯 git 变更（提交/删除/重命名）。响应里带 approximate: true 与说明。
    'session.changes': async (rc, p) => {
      const events = await collectSessionEvents(rc, str(p, 'sessionId'))
      const files = buildChanges(events)
      return {
        files,
        approximate: true,
        note: '来自会话事件里的文件工具记录；不含 shell 改动、二进制与 git 操作',
      }
    },

    'session.diff': async (rc, p) => {
      const events = await collectSessionEvents(rc, str(p, 'sessionId'))
      const path = str(p, 'path')
      const found = latestDiffForPath(events, path)
      if (found === undefined) throw new RpcError('session/not-found', '这个文件没有可用的差异记录')
      return found
    },

    // ── 模型选择 ──────────────────────────────────────────────────────────
    'session.modelCatalog': async (rc) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions === undefined) throw new RpcError('host/unavailable', '宿主没有会话服务')
      /**
       * 注意两个不同的类型，字段名不一样：
       *   ModelSelection      = { provider, model, reasoningEffort? }
       *   ModelProviderGroup  = { id, name, models[] }   ← 组用 id，不叫 provider
       * 之前把组也读成 provider，于是 group.provider 全是空串。
       */
      const catalog = (await sessions.modelCatalog?.()) as {
        default?: { provider?: string; model?: string }
        groups?: readonly {
          id?: string
          name?: string
          models?: readonly {
            id: string
            name: string
            description?: string
            /** 推理能力声明。结构随 provider adapter 而异，原样透传。 */
            reasoning?: unknown
          }[]
        }[]
        failures?: readonly { id?: string; name?: string; message?: string }[]
      } | undefined
      if (catalog === undefined) throw new RpcError('host/unavailable', '宿主不支持模型目录')

      return {
        default: {
          provider: catalog.default?.provider ?? '',
          model: catalog.default?.model ?? '',
        },
        // 摊平成 [provider, [model...]] 列表，App 端直接渲染
        groups: (catalog.groups ?? []).map((g) => ({
          provider: g.id ?? '',
          name: g.name ?? g.id ?? '',
          models: (g.models ?? []).map((m) => ({
            id: m.id,
            name: m.name,
            ...(m.description === undefined ? {} : { description: m.description }),
            // 原样透传：不同 adapter 的 reasoning 结构不一样，
            // 这里不解读，只让 App 知道"这个模型支持推理"
            ...(m.reasoning === undefined ? {} : { reasoning: m.reasoning }),
          })),
        })),
        failures: (catalog.failures ?? []).map((f) => ({
          name: f.name ?? f.id ?? '未知',
          message: f.message ?? '',
        })),
      }
    },

    'session.selectModel': async (rc, p) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions === undefined) throw new RpcError('host/unavailable', '宿主没有会话服务')
      if (sessions.selectModel === undefined) throw new RpcError('host/unavailable', '宿主不支持选择模型')
      const sessionId = str(p, 'sessionId')
      const provider = str(p, 'provider')
      const model = str(p, 'model')
      try {
        const value = (await sessions.selectModel({ sessionId, provider, model })) as {
          selected?: { provider?: string; model?: string }
        }
        return {
          ok: true,
          selected: {
            provider: value?.selected?.provider ?? provider,
            model: value?.selected?.model ?? model,
          },
        }
      } catch (error) {
        throw new RpcError('host/internal', error instanceof Error ? error.message : String(error))
      }
    },

    // ── 新建会话 ──────────────────────────────────────────────────────────
    //
    // dsh 的 session.create({ workspaceId?, cwd?, sessionId?, agentPreset? })：
    //   - workspaceId 与 cwd 二选一（会话要么归属某个工作区，要么自己占一个目录）
    //   - sessionId 可传：若那个 id 下存着一个**空白会话**会复用，否则按新 id 建
    // 移动端不传 sessionId，让宿主自己生成。
    'session.create': async (rc, p) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions?.create === undefined) throw new RpcError('host/unavailable', '宿主不支持新建会话')
      const workspaceId = typeof p['workspaceId'] === 'string' && p['workspaceId'].length > 0 ? p['workspaceId'] : undefined
      const cwd = typeof p['cwd'] === 'string' && p['cwd'].length > 0 ? p['cwd'] : undefined
      if (workspaceId === undefined && cwd === undefined) {
        throw new RpcError('rpc/bad-args', '需要指定工作区或目录')
      }
      try {
        const value = (await sessions.create({
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(cwd === undefined ? {} : { cwd }),
          ...(typeof p['agentPreset'] === 'string' ? { agentPreset: p['agentPreset'] } : {}),
        })) as { sessionId?: unknown; agentPreset?: unknown } | undefined
        const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : ''
        if (sessionId.length === 0) throw new RpcError('host/internal', '宿主没有返回会话 id')
        return {
          sessionId,
          ...(typeof value?.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
        }
      } catch (error) {
        if (error instanceof RpcError) throw error
        throw new RpcError('host/internal', error instanceof Error ? error.message : String(error))
      }
    },

    // ── 会话管理 ──────────────────────────────────────────────────────────
    'session.rename': async (rc, p) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions === undefined) throw new RpcError('host/unavailable', '宿主没有会话服务')
      const sessionId = str(p, 'sessionId')
      const title = str(p, 'title').trim()
      if (title.length === 0 || title.length > 120) {
        throw new RpcError('rpc/bad-args', '标题需为 1-120 个字符')
      }
      try {
        await sessions.rename({ sessionId, title })
        return { ok: true, sessionId, title }
      } catch (error) {
        throw new RpcError('host/internal', error instanceof Error ? error.message : String(error))
      }
    },

    // dsh 没有"删除会话"，只有 archive（移出列表但保留日志）。
    // 我们不去发明一个删除——那会让用户以为记录没了，实际还在磁盘上。
    'session.archive': async (rc, p) => {
      const workspaces = rc.ctx.get<WorkspaceController>('workspaceController', false)
      if (workspaces?.archiveSession === undefined) {
        throw new RpcError('host/unavailable', '宿主没有工作区服务')
      }
      const sessionId = str(p, 'sessionId')
      // 正在跑的会话默认拒绝归档（dsh 的 workspace/session-active）；
      // 客户端明确要"连运行中一起停"时传 force。
      const force = p['force'] === true
      try {
        await workspaces.archiveSession({ sessionId, ...(force ? { stopRunning: true } : {}) })
        return { ok: true, sessionId }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/session-active/i.test(message)) {
          throw new RpcError('session/busy', '会话正在运行，先停止或勾选强制归档')
        }
        throw new RpcError('host/internal', message)
      }
    },

    'session.unarchive': async (rc, p) => {
      const workspaces = rc.ctx.get<WorkspaceController>('workspaceController', false)
      if (workspaces?.unarchiveSession === undefined) {
        throw new RpcError('host/unavailable', '宿主没有工作区服务')
      }
      const sessionId = str(p, 'sessionId')
      await workspaces.unarchiveSession({ sessionId })
      return { ok: true, sessionId }
    },

    // ── M2 待实现：文件浏览（只读；上传在 M1）──────────────────────────────
    'fs.list': notImplemented('fs.list'),
    'fs.stat': notImplemented('fs.stat'),
    'fs.read': notImplemented('fs.read'),


    // ── M2 待实现：仓库与 git（全部只读，走 child_process 调 git）──────────
    'repo.list': notImplemented('repo.list'),
    'repo.info': notImplemented('repo.info'),
    'git.status': notImplemented('git.status'),
    'git.diff': notImplemented('git.diff'),
    'git.log': notImplemented('git.log'),
    'git.show': notImplemented('git.show'),
    'git.branches': notImplemented('git.branches'),

    // ── M3 待实现：GitHub 远程仓库（需要 PC 侧 token，caps.gh 默认 0）──────
    'repo.gh.tree': notImplemented('repo.gh.tree'),
    'repo.gh.file': notImplemented('repo.gh.file'),

    // ── M1 待实现：插件管理 ───────────────────────────────────────────────
    'plugin.list': notImplemented('plugin.list'),
    'plugin.inspect': notImplemented('plugin.inspect'),
    'plugin.install': notImplemented('plugin.install'),
    'plugin.remove': notImplemented('plugin.remove'),

    // ── 通道与终端 ────────────────────────────────────────────────────────
    'chan.open': notImplemented('chan.open'),
    'chan.close': notImplemented('chan.close'),
    'term.create': notImplemented('term.create'),
  } as const satisfies Record<Method, Handler>

  return handlers
}

/** 语义便利：把 dsh 的服务取出来（软读，缺了就是 undefined）。 */
export function services(ctx: DshContext): {
  sessions: SessionController | undefined
  plugins: PluginManager | undefined
} {
  return {
    sessions: ctx.get<SessionController>('sessionController', false),
    plugins: ctx.get<PluginManager>('pluginManager', false),
  }
}

export { METHOD_POLICY }

/**
 * 把队列操作的宿主错误翻译成客户端能懂的错误码。
 *
 * dsh 的原始错误是字符串（session/queue-item-not-found、session/steer-unavailable），
 * 直接透传客户端只会显示一串英文代码。
 */
function queueError(error: unknown): RpcError {
  const message = error instanceof Error ? error.message : String(error)
  if (/queue-item-not-found/i.test(message)) {
    return new RpcError('session/not-found', '这条排队消息已经不在了（可能刚好被消费）')
  }
  if (/steer-unavailable/i.test(message)) {
    return new RpcError('session/busy', '现在不能插话：agent 不在运行中，或这条不在待发队列里')
  }
  return new RpcError('host/internal', message)
}

/**
 * 读一个会话的近期事件（用于重建产物）。
 *
 * 复用 sessionController.follow：它的首帧就是 snapshot（含 records），
 * 拿到就断开——不要在这里留一个长订阅。
 */
async function collectSessionEvents(rc: RouteContext, sessionId: string): Promise<readonly unknown[]> {
  const sessions = sessionsOf(rc.ctx)
  if (sessions?.follow === undefined) throw new RpcError('host/unavailable', '宿主不支持读取会话事件')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  timer.unref?.()
  try {
    for await (const frame of sessions.follow(
      { address: { kind: 'session', sessionId }, maxMessages: 200 },
      controller.signal,
    )) {
      const f = frame as { type?: string; records?: readonly unknown[] }
      if (f.type !== 'snapshot') break
      return f.records ?? []
    }
    return []
  } catch (error) {
    throw new RpcError('host/internal', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** 仅供测试：把内部解码函数暴露出来（不参与运行时路径）。 */
export const decodeBase64ForTest = decodeBase64

/** dsh 的附件服务（只声明用到的那个入口）。 */
interface FileUploadsService {
  uploadStream(request: {
    sessionId: string
    data: AsyncIterable<Uint8Array>
    signal?: AbortSignal
    name?: string
  }): Promise<unknown>
}

/** 单附件上限：手机端 8MB 已经够发图片与文档，再大传输体验会崩。 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

/**
 * base64 → Uint8Array。
 *
 * 不用 `Uint8Array.from(atob(s), c => c.charCodeAt(0))`：那会在内存里
 * 生成一个和内容等长的字符串数组，大文件直接把主线程卡住。
 * 这里按 8KB 分块喂给 atob，峰值内存低一个数量级。
 */
function decodeBase64(input: string): Uint8Array {
  const clean = input.includes(',') ? input.slice(input.indexOf(',') + 1) : input
  const chunk = 8 * 1024
  const out: number[] = []
  for (let i = 0; i < clean.length; i += chunk) {
    const slice = clean.slice(i, i + chunk)
    const bin = atob(slice)
    for (let j = 0; j < bin.length; j++) out.push(bin.charCodeAt(j))
  }
  return Uint8Array.from(out)
}
