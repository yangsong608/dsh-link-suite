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

import { RpcError, DEFAULT_CAPS, METHOD_POLICY, type DeviceRole, type Method } from '@dsh-link/protocol'
import type { DshContext, SessionController, PluginManager, WorkspaceRegistry } from '../dsh.js'
import type { LinkConfig } from '../config.js'
import type { LockService } from '../lock/index.js'
import type { DeviceRegistry } from './devices.js'
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
  /**
   * 网关自身的引用。只在 plugin apply() 里晚绑定一次：
   * gateway 需要 handlers，handlers 又需要 gateway（pair.finish 要升格连接），
   * 用 getter 打破这个循环，而不是引入可变全局。
   */
  readonly gateway: () =>
    | {
        authenticate(connId: string, deviceId: string, role: DeviceRole, label: string): boolean
        disconnectDevice(deviceId: string): number
      }
    | undefined
  /** 会话事件订阅表（follow 打开后由 server 推帧）。M1 可缺省。 */
  readonly subscriptions?: {
    open(sessionId: string, connId: string): boolean
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
      return {
        code: session.code,
        expiresAt: session.expiresAt,
        hostId: rc.hostId,
        // 指纹给用户比对"这台机器确实是它"，不做信任决策
        fingerprint: rc.hostId.slice(-6),
        // 码本身必须由人在 PC 上确认，这里明确告诉客户端下一步
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

    'device.list': async (rc) => ({ devices: rc.devices.list() }),

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
        workspaces: workspaces.map((ws) => ({
          id: String(ws.id),
          name: ws.title,
          path: ws.path,
          pinned: false,
          sessionCount: 0,
          updatedAt: Date.parse(ws.createdAt) || Date.now(),
        })),
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
        return { sessions: toSessionSummaries(value?.items ?? [], workspaceId) }
      } finally {
        clearTimeout(timer)
      }
    },

    'session.prompt': async (rc, p, meta) => {
      const sessions = sessionsOf(rc.ctx)
      if (sessions === undefined) throw new RpcError('host/unavailable', '宿主没有会话服务')
      const sessionId = str(p, 'sessionId')
      const text = str(p, 'text')

      // requestId 必须由客户端提供并持久化（断线重发时用它去重）。
      // 客户端没给就现造一个——但那样重发可能重复执行，所以文档里要求 App 必须传。
      const requestId = typeof p['requestId'] === 'string' && p['requestId'].length > 0
        ? p['requestId']
        : randomUUID()

      const controller = new AbortController()
      try {
        await sessions.prompt(
          {
            requestId,
            sessionId,
            // steer：用户此刻就想影响正在跑的这一轮。
            // queue 语义留给 session.queue.*（本轮未实现）。
            mode: 'steer',
            content: [{ type: 'text', text }],
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
    'session.queue.list': notImplemented('session.queue.list'),
    'session.queue.push': notImplemented('session.queue.push'),
    'session.queue.edit': notImplemented('session.queue.edit'),
    'session.queue.remove': notImplemented('session.queue.remove'),
    'session.queue.reorder': notImplemented('session.queue.reorder'),
    'session.queue.clear': notImplemented('session.queue.clear'),

    // ── M2 待实现：会话产物 ───────────────────────────────────────────────
    'session.changes': notImplemented('session.changes'),
    'session.diff': notImplemented('session.diff'),

    // ── M2 待实现：文件浏览（只读；上传在 M1）──────────────────────────────
    'fs.list': notImplemented('fs.list'),
    'fs.stat': notImplemented('fs.stat'),
    'fs.read': notImplemented('fs.read'),
    'fs.upload': notImplemented('fs.upload'),

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
