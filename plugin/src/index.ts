/**
 * dsh-link 插件入口。
 *
 * 一个包、两个子系统：
 *   - lock     锁定状态机（锁 dsh 的操作能力，需求 9）
 *   - gateway  多设备 WSS 网关（App 侧，需求 1–7）
 * 两者由 config 独立开关，互不强依赖。
 *
 * 三条不妥协：
 *   1. 不 patch dsh 内部（不接管 connection、不改 webServer.server、不注入 trustedHosts）
 *   2. 所有 dsh 服务走 `ctx.get(name, false)` 软读，缺了就是能力降级而不是崩溃
 *   3. 卸载即撤销（ctx.effect），不留监听器、不留端口
 */

import { promises as fs } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { LockState } from '@dsh-link/protocol'
import { bindHost, normalizeConfig, type LinkConfig } from './config.js'
import type { DshContext, WebServerService } from './dsh.js'
import { LockService } from './lock/index.js'
import { DeviceRegistry } from './gateway/devices.js'
import { renderSetupPage, SETUP_PATH } from './setup-page.js'
import { encodeQr, encodePairUri, pairPayloadFromEndpoint } from '@dsh-link/protocol'
import { createApprovalBridge, createSubscriptionHub, type Deps } from './adapters/live.js'
import { createHandlers, type RouteContext } from './gateway/router.js'
import { startGateway, type Gateway } from './gateway/server.js'

export const name = 'dsh-link'

/**
 * 刻意留空：全部软读。
 * 声明 inject 会让"没装 webServer 的 profile"直接激活失败——而这个插件在没有它时
 * 仍然可以提供锁屏，只是没有 HTTP 状态接口。
 */
export const inject: string[] = []

const LINK_DIR = join(homedir(), '.dsh', 'dsh-link')

/**
 * 取本机全部非回环 IPv4。
 *
 * 为什么返回**列表**而不是一个地址：这台开发机就有 en0 与 en6 两块网卡
 * 在同一网段（172.80.2.0/24），默认路由走 en6。只挑一个地址绑定，手机会
 * 连不上那块网卡——而"手机走哪块网卡"取决于路由，宿主猜不出来。
 *
 * 所以：全部绑定。多监听几个地址的成本可以忽略，连不上的风险不能忽略。
 */
function lanAddresses(): string[] {
  const ifaces = networkInterfaces()
  const candidates: string[] = []
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      candidates.push(info.address)
    }
  }
  // 去重并排序，让日志可读、让"同一次启动的绑定顺序"稳定
  return [...new Set(candidates)].sort()
}

async function ensureHostId(): Promise<string> {
  const file = join(LINK_DIR, 'host.json')
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as { hostId?: unknown }
    if (typeof parsed.hostId === 'string' && parsed.hostId.length >= 8) return parsed.hostId
  } catch {
    // 首次启动
  }
  const hostId = `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  await fs.mkdir(LINK_DIR, { recursive: true, mode: 0o700 })
  await fs.writeFile(file, `${JSON.stringify({ hostId }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return hostId
}

const isLoopback = (addr: string | undefined): boolean =>
  addr === undefined || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')

export async function apply(ctx: DshContext, rawConfig: unknown): Promise<void> {
  const cfg: LinkConfig = normalizeConfig(rawConfig)
  if (!cfg.enabled) {
    ctx.logger?.info('[dsh-link] 已在配置中禁用')
    return
  }

  const hostId = await ensureHostId()
  const dshVersion = (ctx.get<{ version?: string }>('appMeta', false)?.version) ?? 'unknown'

  // ── 锁屏 ────────────────────────────────────────────────────────────────
  const lock = new LockService(ctx, cfg, {
    store: join(LINK_DIR, 'lock.json'),
    audit: join(LINK_DIR, 'lock-audit.jsonl'),
  })
  await lock.init()

  // ── 设备表 ──────────────────────────────────────────────────────────────
  // 先于网关创建：handlers 需要它，而配对是网关能不能用的前提。
  const devices = new DeviceRegistry(join(LINK_DIR, 'devices.json'))
  await devices.load()

  /**
   * 手机要连的地址，由宿主算出来（用户不该自己去查 ifconfig）。
   *
   * 顺序即优先级：
   *   1. relayUrl（配了就是公网可达的中继/nps 地址，最通用）
   *   2. 各网卡的局域网地址（同 WiFi 下最快，不依赖外网）
   *
   * 为什么中继排第一：局域网地址只在同一网段有效，而中继在任何网络下都通。
   * 用户扫码时期望"一次成功"，所以默认给最可能成功的那个。
   */
  const lanEndpoints = lanAddresses().map((ip) => `ws://${ip}:${cfg.gateway.port}/dshlink`)
  const endpoints = cfg.gateway.relayUrl === undefined
    ? lanEndpoints
    : [cfg.gateway.relayUrl, ...lanEndpoints]

  // ── 订阅与审批 ──────────────────────────────────────────────────────────
  // 两者都依赖网关（推帧 / 广播），所以用晚绑定：先建对象，网关起来后它们读到的
  // getter 已经有值。dispose 由 ctx.effect 统一收尾。
  let gateway: Gateway | undefined
  const deps: Deps = {
    ctx,
    lock,
    sendEvent: (connId: string, channel: string, method: string, payload: unknown) => {
      gateway?.sendEvent(connId, channel, method, payload)
    },
    broadcast: (method: string, payload: unknown) => {
      gateway?.broadcast(method, payload)
    },
    deviceOf: (connId: string) => gateway?.deviceOf(connId),
    get authenticatedConnections() {
      return gateway?.authenticatedConnections ?? 0
    },
  }
  const subscriptions = createSubscriptionHub(deps)
  const approvals = createApprovalBridge(deps)

  // ── 网关 ────────────────────────────────────────────────────────────────
  const rc: RouteContext = {
    ctx,
    cfg,
    lock,
    devices,
    hostId,
    dshVersion,
    endpoints,
    // 晚绑定：网关需要 handlers，handlers 又需要网关（pair.finish 要升格连接）。
    gateway: () => gateway,
    subscriptions: {
      open: (sessionId, connId) => {
        // 未认证连接不该能订阅会话事件
        const deviceId = gateway?.deviceOf(connId)
        if (deviceId === undefined) return false
        return subscriptions.open(sessionId, connId, deviceId)
      },
    },
    approvals: {
      settle: (id, outcome, deviceId) => approvals.settle(id, outcome, deviceId),
    },
  }

  if (cfg.gateway.enabled) {
    try {
      const host = bindHost(cfg.gateway.bind)
      // 绑 0.0.0.0 时必须给出"允许哪些本机地址被连"的白名单，
      // 否则监听会落到 VPN / 公网网卡上。loopback 模式不需要白名单。
      const allowedLocal = cfg.gateway.bind === 'loopback' ? undefined : lanAddresses()
      gateway = await startGateway({
        rc,
        handlers: createHandlers(),
        port: cfg.gateway.port,
        host,
        heartbeatMs: cfg.gateway.heartbeatMs,
        allowedOrigins: cfg.gateway.allowedOrigins,
        allowedLocalAddresses: allowedLocal,
      })
      // 锁状态一变，立刻推给所有在线设备（App 不用轮询）
      ctx.on('dsh-link/lock-changed', (state) => {
        gateway?.broadcast('lock.changed', state as LockState)
      })
    } catch (error) {
      // 端口占用、网卡取不到、权限不足——这些都是"远程访问不可用"，
      // 不是"锁屏不可用"。原来没有 try/catch，一个可选子系统的失败
      // 会把整个插件（包括与端口无关的锁屏）一起拖死。
      ctx.logger?.error(
        '[dsh-link] 网关启动失败，远程访问已降级（锁屏不受影响）：%s',
        error instanceof Error ? error.message : String(error),
      )
      gateway = undefined
    }
  }

  // ── 本机 HTTP 面（给浏览器里的锁屏层用）─────────────────────────────────
  const webServer = ctx.get<WebServerService>('webServer', false)
  if (webServer !== undefined) {
    const off = webServer.register({
      kind: 'prefix',
      path: '/dsh-link',
      handler: makeHttpHandler(lock, gateway, devices, cfg, hostId, endpoints),
    })
    ctx.effect(() => () => off(), 'dsh-link: http routes')
  }

  ctx.effect(
    () => () => {
      subscriptions.dispose()
      approvals.dispose()
      void lock.dispose()
      void gateway?.close()
    },
    'dsh-link: gateway + lock',
  )

  ctx.logger?.info(
    '[dsh-link] 就绪 · 锁屏=%s · 网关=%s',
    lock.armed ? 'armed' : 'off',
    gateway === undefined ? 'off' : `:${gateway.port}`,
  )
}

/**
 * 本机 HTTP 面。只服务四件事：读锁状态、解锁、读审计、PC 上确认远程请求。
 *
 * 全部限制回环来源——这些接口能改锁状态，一旦被反代暴露就等于没有锁。
 * 注意这是 best-effort：反代会改写 remoteAddress，真正可靠的做法是让 dsh 的
 * connection 层来鉴权（本插件不碰那一层，见 docs/06 §3）。
 */
function makeHttpHandler(
  lock: LockService,
  gateway: Gateway | undefined,
  devices: DeviceRegistry,
  cfg: LinkConfig,
  hostId: string,
  endpoints: readonly string[],
) {
  return async (rawReq: unknown, rawRes: unknown): Promise<void> => {
    const req = rawReq as IncomingMessage
    const res = rawRes as ServerResponse
    const remote = req.socket.remoteAddress
    if (!isLoopback(remote)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'loopback only' }))
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }

    try {
      // 设置页：把"只有接口、没有入口"的能力补上一个可点的界面。
      if (url.pathname === SETUP_PATH && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderSetupPage(hostId, endpoints, gateway?.port ?? cfg.gateway.port))
        return
      }

      // 用户从根路径进来时给一个跳转，省得记地址
      if ((url.pathname === '/dsh-link' || url.pathname === '/dsh-link/') && req.method === 'GET') {
        res.writeHead(302, { location: SETUP_PATH })
        res.end()
        return
      }

      if (url.pathname === '/dsh-link/lock' && req.method === 'GET') {
        json(200, {
          ...lock.get(),
          armed: lock.armed,
          hasPassword: lock.hasPassword,
          // 没密码时 tell the client 为什么没锁——比只回 armed:false 有用得多，
          // 否则浏览器半只能显示"未锁定"，用户不知道是没开还是没配。
          armedReason: lock.armed ? 'ready' : lock.hasPassword ? 'disabled' : 'no-password',
          connections: gateway?.connections ?? 0,
        })
        return
      }

      if (url.pathname === '/dsh-link/lock' && req.method === 'POST') {
        const body = await readJson(req)
        const action = body['action']
        if (action === 'lock') {
          lock.lock('manual')
          json(200, lock.get())
          return
        }
        if (action === 'touch') {
          lock.touch()
          json(200, { ok: true })
          return
        }
        json(400, { error: 'unknown action' })
        return
      }

      if (url.pathname === '/dsh-link/lock/unlock' && req.method === 'POST') {
        const body = await readJson(req)
        const password = body['password']
        if (typeof password !== 'string') {
          json(400, { error: 'password required' })
          return
        }
        try {
          const result = lock.unlock(password, 'owner')
          json(200, result)
        } catch (e) {
          const err = e as { code?: string; message?: string; details?: Record<string, unknown> }
          json(401, { error: err.message ?? 'unlock failed', code: err.code, details: err.details })
        }
        return
      }

      // ── 密码生命周期 ────────────────────────────────────────────────────
      // 这三条是"锁屏能不能用"的开关。原来 setPassword() 只有测试在调，
      // 于是锁屏从装上那刻起就是未武装状态——功能等于不存在。
      if (url.pathname === '/dsh-link/lock/password' && req.method === 'POST') {
        const body = await readJson(req)
        const next = body['next']
        const current = body['current']
        if (typeof next !== 'string' || next.length < 8) {
          json(400, { error: '密码至少 8 位', code: 'lock/weak-password' })
          return
        }
        try {
          if (lock.hasPassword) {
            if (typeof current !== 'string') {
              json(400, { error: '变更密码需要提供当前密码', code: 'lock/bad-args' })
              return
            }
            await lock.changePassword(current, next)
          } else {
            await lock.setPassword(next)
          }
          json(200, { ok: true, armed: lock.armed })
        } catch (e) {
          const err = e as { code?: string; message?: string; details?: Record<string, unknown> }
          json(401, { error: err.message ?? 'setting password failed', code: err.code, details: err.details })
        }
        return
      }

      if (url.pathname === '/dsh-link/lock/password' && req.method === 'DELETE') {
        const body = await readJson(req)
        const current = body['current']
        if (!lock.hasPassword) {
          json(200, { ok: true, armed: false })
          return
        }
        if (typeof current !== 'string') {
          json(400, { error: '清除密码需要提供当前密码', code: 'lock/bad-args' })
          return
        }
        try {
          // 先验后清：clearPassword 本身不校验，直接把验证放在这里，
          // 避免任何一个能打到回环端口的进程把锁拆掉。
          lock.unlock(current, 'owner')
          await lock.clearPassword()
          json(200, { ok: true, armed: false })
        } catch (e) {
          const err = e as { code?: string; message?: string; details?: Record<string, unknown> }
          json(401, { error: err.message ?? 'clear password failed', code: err.code, details: err.details })
        }
        return
      }

      // PC 侧轮询待确认的远程解锁请求（浏览器半据此弹确认窗）。
      if (url.pathname === '/dsh-link/lock/pending' && req.method === 'GET') {
        json(200, { pending: lock.pendingRequests() })
        return
      }

      // ── 配对（PC 侧）────────────────────────────────────────────────────
      // 用户必须在电脑前确认，手机才有码可输。这与安全模型同向：
      // 配对码只是"谁先拿到"的凭据，真正的授权动作是这里的 approve。
      if (url.pathname === '/dsh-link/pair/start' && req.method === 'POST') {
        // PC 侧点「生成配对码」= 本人在电脑前 = 物理在场证明，直接预批准
        const session = devices?.startPair(cfg.gateway.pairTtlMs, true)
        if (session === undefined) {
          json(503, { error: '设备表未就绪' })
          return
        }

        // 关键：把"手机该连哪个地址"一并算出来。
        // 原来只回一个码，用户得自己去设置页翻 IP 手抄——那是把
        // 宿主能做的事推给了用户。现在每个网卡一个候选，外加二维码。
        const fingerprint = hostId.slice(-6)
        const candidates = endpoints.map((wsUrl) => {
          const payload = pairPayloadFromEndpoint(wsUrl, session.code, fingerprint)
          if (payload === undefined) return undefined
          const uri = encodePairUri(payload)
          return {
            wsUrl,
            uri,
            // 二维码矩阵直接给出去：前端不用引任何 QR 库，照着画格子就行
            qr: encodeQr(uri),
          }
        }).filter((c): c is NonNullable<typeof c> => c !== undefined)

        json(200, {
          code: session.code,
          expiresAt: session.expiresAt,
          hostId,
          fingerprint,
          // 首选地址（第一个网卡）。多网卡时手机若连不上，换下一个。
          wsUrl: candidates[0]?.wsUrl,
          candidates: candidates.map((c) => ({ wsUrl: c.wsUrl, uri: c.uri })),
          qr: candidates[0]?.qr,
        })
        return
      }

      if (url.pathname === '/dsh-link/pair/approve' && req.method === 'POST') {
        const body = await readJson(req)
        const code = String(body['code'] ?? '')
        const ok = devices?.approvePair(code) ?? false
        json(ok ? 200 : 404, ok ? { approved: true, code } : { error: '配对码不存在或已过期' })
        return
      }

      if (url.pathname === '/dsh-link/pair/pending' && req.method === 'GET') {
        json(200, {
          pending: (devices?.pendingPairs() ?? []).map((s) => ({
            code: s.code,
            createdAt: s.createdAt,
            expiresAt: s.expiresAt,
            approved: s.approved,
          })),
        })
        return
      }

      if (url.pathname === '/dsh-link/pair/devices' && req.method === 'GET') {
        json(200, { devices: devices?.list() ?? [] })
        return
      }

      if (url.pathname === '/dsh-link/pair/revoke' && req.method === 'POST') {
        const body = await readJson(req)
        const deviceId = String(body['deviceId'] ?? '')
        const revoked = (await devices?.revoke(deviceId)) ?? undefined
        if (revoked === undefined) {
          json(404, { error: '设备不存在' })
          return
        }
        gateway?.disconnectDevice(revoked)
        json(200, { revoked, deviceId: revoked })
        return
      }

      if (url.pathname === '/dsh-link/lock/request' && req.method === 'POST') {
        const body = await readJson(req)
        const deviceId = String(body['deviceId'] ?? '')
        const approved = body['approved'] === true
        json(200, lock.settleRemote(deviceId, approved))
        return
      }

      json(404, { error: 'not found' })
    } catch (e) {
      ctxError(res, e)
    }
  }
}

function ctxError(res: ServerResponse, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e)
  if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: message }))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.byteLength
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
}
