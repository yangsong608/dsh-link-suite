/**
 * 路由表：方法名 → 实现。
 *
 * 只登记**实现存在**的方法。没实现的落在 `notImplemented` 上，返回
 * `host/unavailable` 而不是 500 —— App 据此显示"这台机器暂不支持"，而不是"出错了"。
 *
 * 这里一律通过 `ctx.get(name, false)` 软读 dsh 服务：
 * 严格代理下直接 `ctx.sessionController` 会抛错，即使服务不存在也一样。
 */

import { RpcError, DEFAULT_CAPS, METHOD_POLICY, type Method } from '@dsh-link/protocol'
import type { DshContext, SessionController, PluginManager } from '../dsh.js'
import type { LinkConfig } from '../config.js'
import type { LockService } from '../lock/index.js'

export interface CallMeta {
  readonly deviceId: string
  readonly role: keyof typeof ROLE_ORDER
  readonly remoteAddress: string
}

export const ROLE_ORDER = { viewer: 0, operator: 1, approver: 2, admin: 3 } as const

export interface RouteContext {
  readonly ctx: DshContext
  readonly cfg: LinkConfig
  readonly lock: LockService
  readonly hostId: string
  readonly dshVersion: string
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
      name: rc.cfg.gateway.bind === 'lan' ? 'DSH Link (LAN)' : 'DSH Link (loopback)',
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
      if (rc.cfg.lock.allowDeviceUnlock) {
        throw new RpcError('lock/no-password-set', '本机配置为不允许设备直接解锁，请使用密码')
      }
      const ok = await rc.lock.requestRemote(meta.deviceId, meta.deviceId)
      if (!ok) throw new RpcError('lock/request-timeout', '主机未在 30 秒内确认')
      return { unlocked: true }
    },

    'lock.lock': async (rc) => {
      rc.lock.lock('remote')
      return rc.lock.get()
    },

    // ── M1 待实现：连接与工作区骨架 ───────────────────────────────────────
    'pair.start': notImplemented('pair.start'),
    'pair.finish': notImplemented('pair.finish'),
    'device.list': notImplemented('device.list'),
    'device.revoke': notImplemented('device.revoke'),
    'workspace.list': notImplemented('workspace.list'),
    'workspace.create': notImplemented('workspace.create'),
    'dir.list': notImplemented('dir.list'),

    // ── M1 待实现：会话主线 ───────────────────────────────────────────────
    'session.list': notImplemented('session.list'),
    'session.prompt': notImplemented('session.prompt'),
    'session.cancel': notImplemented('session.cancel'),
    'session.follow': notImplemented('session.follow'),
    'approval.answer': notImplemented('approval.answer'),

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
