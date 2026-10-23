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

/**
 * 运行时配置（界面可改、重启仍在）。
 *
 * 只存"用户在界面上显式设置过"的东西：中继地址、额外 Origin。
 * 不存密码或令牌——那些有自己的文件与权限（见 lock.json / devices.json）。
 */
interface RuntimeConfig {
  readonly relayUrl?: string
  readonly allowedOrigins?: readonly string[]
  /** 网关开关（界面可改，重启仍在）。 */
  readonly gatewayEnabled?: boolean
  /** 监听端口，默认 7443。 */
  readonly gatewayPort?: number
}

async function loadRuntime(dir: string): Promise<RuntimeConfig> {
  try {
    const raw = await fs.readFile(join(dir, 'runtime.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: {
      relayUrl?: string
      allowedOrigins?: readonly string[]
      gatewayEnabled?: boolean
      gatewayPort?: number
    } = {}
    if (typeof parsed['gatewayEnabled'] === 'boolean') out.gatewayEnabled = parsed['gatewayEnabled']
    if (typeof parsed['gatewayPort'] === 'number' && parsed['gatewayPort'] >= 1024 && parsed['gatewayPort'] <= 65535) {
      out.gatewayPort = parsed['gatewayPort']
    }
    if (typeof parsed['relayUrl'] === 'string' && /^wss?:\/\//.test(parsed['relayUrl'])) {
      out.relayUrl = parsed['relayUrl']
    }
    if (Array.isArray(parsed['allowedOrigins'])) {
      out.allowedOrigins = parsed['allowedOrigins'].filter((x): x is string => typeof x === 'string')
    }
    return out
  } catch {
    return {}
  }
}

async function saveRuntime(dir: string, value: RuntimeConfig): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(join(dir, 'runtime.json'), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
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

  /**
   * 运行时叠加配置：中继地址与额外 Origin。
   *
   * 为什么单独存一份而不是改 profile 的 cordis 配置：
   *   1. 用户不会去手编 YAML；界面里填了就该立刻生效
   *   2. cordis 配置由 dsh 管理，插件去改它是越界的
   * 所以存在 ~/.dsh/dsh-link/runtime.json，启动时读、界面改时写。
   * 优先级：runtime 覆盖 profile 配置（用户最后一次的显式选择说了算）。
   */
  const runtime = await loadRuntime(LINK_DIR)

  // relayUrl 可变：界面里改了要立刻生效，不必改 profile 的 cordis 配置。
  // 放进对象是因为要跨请求共享（HTTP 处理器拿不到闭包变量）。
  const relay: RelayState = {
    relayUrl: runtime.relayUrl ?? cfg.gateway.relayUrl,
    endpoints: [],
  }

  const recomputeEndpoints = (): string[] =>
    relay.relayUrl === undefined ? [...lanEndpoints] : [relay.relayUrl, ...lanEndpoints]

  relay.endpoints = recomputeEndpoints()
  // 配对与 RPC 都读这个 getter：改了中继后不必重启，下一次生成码就用新地址
  const endpoints = relay.endpoints

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
      pushHistory: (sessionId, connId) => subscriptions.pushHistory(sessionId, connId),
    },
    approvals: {
      settle: (id, outcome, deviceId) => approvals.settle(id, outcome, deviceId),
    },
  }

  /** 网关运行状态（启动失败原因给设置页看）。 */
  const gwState: { gatewayError?: string } = {}
  /*
   * 网关的有效开关与端口。
   *
   * 优先级：界面设置过（runtime.json）> 配置文件默认。
   * 之所以要"界面值"这一层：用户希望在设置里点一下就能开/关并改端口，
   * 而不是去手编 YAML 再重启 DSH。
   */
  let gwEnabled = runtime.gatewayEnabled ?? cfg.gateway.enabled
  let gwPort = runtime.gatewayPort ?? cfg.gateway.port

  /*
   * 启动网关。抽成函数是为了能被**自愈循环**重复调用：
   * 首次启动失败（典型是重启时端口还没释放）不应该让远程访问一直废到下次重启。
   */
  const startGatewayOnce = async (): Promise<void> => {
    try {
      const host = bindHost(cfg.gateway.bind)
      // 绑 0.0.0.0 时必须给出"允许哪些本机地址被连"的白名单，
      // 否则监听会落到 VPN / 公网网卡上。loopback 模式不需要白名单。
      const allowedLocal = cfg.gateway.bind === 'loopback' ? undefined : lanAddresses()
      gateway = await startGatewayWithRetry({
        rc,
        handlers: createHandlers(),
        port: gwPort,
        host,
        heartbeatMs: cfg.gateway.heartbeatMs,
        allowedOrigins: cfg.gateway.allowedOrigins,
        allowedLocalAddresses: allowedLocal,
      }, ctx)
      if (gwState.gatewayError !== undefined) {
        ctx.logger?.info?.('[dsh-link] 网关于自愈后恢复监听 %d', cfg.gateway.port)
      }
      gwState.gatewayError = undefined
    } catch (error) {
      // 端口占用、网卡取不到、权限不足——这些都是"远程访问不可用"，
      // 不是"锁屏不可用"。
      const reason = error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}`.trim() : String(error)
      ctx.logger?.error(
        '[dsh-link] 网关启动失败，远程访问已降级（锁屏不受影响）：%s',
        reason,
      )
      gateway = undefined
      /*
       * 把失败原因也暴露到 HTTP 状态里。
       *
       * 只写日志等于用户看不到：卡面上"App 连不上"而设置页一切正常，
       * 是最难自查的一种状态。设置页与 App 都读这个字段。
       */
      gwState.gatewayError = reason
    }
  }

  /** 关网关（供设置页开关调用）。 */
  const stopGateway = async (): Promise<void> => {
    const current = gateway
    gateway = undefined
    try { await current?.close() } catch { /* 已经关了 */ }
    // 主动关闭不是失败，别把上一次的启动错误留在界面上
    gwState.gatewayError = undefined
  }

  if (gwEnabled) {
    await startGatewayOnce()

    // 锁状态一变，立刻推给所有在线设备（App 不用轮询）
    ctx.on('dsh-link/lock-changed', (state) => {
      gateway?.broadcast('lock.changed', state as LockState)
    })

  }

  /*
   * 自愈循环。
   *
   * 放在 if (gwEnabled) 之外：用户在设置里从「关」切成「开」之后，
   * 如果这里没建定时器，后续启动失败就再也没人管了。
   * 循环自己判断开关，关着就什么都不做。
   */
  const HEAL_INTERVAL_MS = 15_000
  const healTimer = setInterval(() => {
    /*
     * 开关关掉时**绝不**自愈。
   *
   * 这里原来只看 gateway === undefined 就重启，于是：用户在设置里
   * 关掉网关 → stopGateway() 把实例关掉 → 15 秒后自愈循环又把它拉起来。
   * 表现就是"我明明关了，7443 还在监听"，而且关不干净。
   *
     * 自愈只应修"该开却没开"（启动时端口竞争、网卡未就绪），
     * 不能覆盖用户的显式选择。
     */
    if (!gwEnabled) return
    if (gateway !== undefined) return
    void startGatewayOnce()
  }, HEAL_INTERVAL_MS)
  // 定时器不能阻止进程退出
  ;(healTimer as unknown as { unref?: () => void }).unref?.()
  ctx.effect(() => () => clearInterval(healTimer), 'dsh-link: gateway self-heal')

  /*
   * 网关控制面：HTTP 处理器在另一个函数里，拿不到 apply 的局部变量，
   * 所以把"开关 / 端口 / 启停"包成一个对象传进去。
   */
  const gwControl = {
    get enabled(): boolean { return gwEnabled },
    set enabled(v: boolean) { gwEnabled = v },
    get port(): number { return gwPort },
    set port(v: number) { gwPort = v },
    start: startGatewayOnce,
    stop: stopGateway,
    state: gwState,
  }

  // ── 本机 HTTP 面（给浏览器里的锁屏层用）─────────────────────────────────
  const webServer = ctx.get<WebServerService>('webServer', false)
  if (webServer !== undefined) {
    const off = webServer.register({
      kind: 'prefix',
      path: '/dsh-link',
      handler: makeHttpHandler(lock, () => gateway, devices, cfg, hostId, relay, recomputeEndpoints, gwState, gwControl),
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
/**
 * 中继配置的可变状态。
 *
 * 单独一个对象是因为它需要**跨请求可变**：界面里改了地址，
 * 后续的 pair.start 要立刻用新地址生成二维码。用闭包变量传不进去
 * （makeHttpHandler 是独立函数），所以用一个可共享的持有者对象。
 */
interface RelayState {
  relayUrl: string | undefined
  endpoints: string[]
}

function makeHttpHandler(
  lock: LockService,
  getGateway: () => Gateway | undefined,
  devices: DeviceRegistry,
  cfg: LinkConfig,
  hostId: string,
  relay: RelayState,
  recomputeEndpoints: () => string[],
  gwState: { gatewayError?: string },
  gwControl: {
    enabled: boolean
    port: number
    start: () => Promise<void>
    stop: () => Promise<void>
    state: { gatewayError?: string }
  },
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
      // 设置页已移除：配置统一放在 dsh 设置 → MOSS Link 面板里。
      // 旧书签访问到 /dsh-link/setup 时给一句明确指引，而不是 404。
      if (url.pathname === '/dsh-link/setup' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          '<!doctype html><meta charset="utf-8">' +
          '<body style="font:14px/1.6 -apple-system,sans-serif;padding:40px;max-width:520px">' +
          '<h2>配置已移到 DSH 设置里</h2>' +
          '<p>打开 DSH → 设置 → 侧栏「MOSS Link」，所有配置（锁屏密码、配对、公网接入、设备管理）都在那里。</p>' +
          '</body>',
        )
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
          connections: getGateway()?.connections ?? 0,
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
      // 配对的唯一用途是"从手机连过来"，网关没开时生成配对码毫无意义：
      // 手机拿到码也连不上，只会让人以为配对坏了。
      if (url.pathname === '/dsh-link/pair/start' && req.method === 'POST') {
        // 网关没开就没有可连的地址：此时生成配对码只会让人白等
        if (getGateway() === undefined) {
          json(409, {
            error: '网关未启动，无法生成配对码',
            gatewayError: gwState.gatewayError ?? '未启动',
          })
          return
        }
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
        // 逐个网卡算候选地址；算不出来的直接跳过（而不是留一个 undefined）。
        const candidates: { wsUrl: string; uri: string; qr: unknown }[] = []
        for (const wsUrl of relay.endpoints) {
          const payload = pairPayloadFromEndpoint(wsUrl, session.code, fingerprint)
          if (payload === undefined) continue
          const uri = encodePairUri(payload)
          candidates.push({ wsUrl, uri, qr: encodeQr(uri) })
        }
        const first = candidates[0]

        json(200, {
          code: session.code,
          expiresAt: session.expiresAt,
          hostId,
          fingerprint,
          // 首选地址（第一个网卡）。多网卡时手机若连不上，换下一个。
          wsUrl: first?.wsUrl,
          candidates: candidates.map((c) => ({ wsUrl: c.wsUrl, uri: c.uri })),
          qr: first?.qr,
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

      // ── 公网接入（中继/反代）配置 ─────────────────────────────────────
      // 这是"没有界面入口"的补课：之前 relayUrl 只有配置文件里能改，
      // 用户不会去手编 YAML。现在设置页能填、能看、能清。
      if (url.pathname === '/dsh-link/config/relay' && req.method === 'GET') {
        json(200, {
          relayUrl: relay.relayUrl ?? null,
          endpoints: relay.endpoints,
          // 当前监听的局域网端口，方便用户拼自己的反代地址
          port: getGateway()?.port ?? cfg.gateway.port,
        })
        return
      }

      // ── 网关开关与端口 ────────────────────────────────────────────────
      if (url.pathname === '/dsh-link/config/gateway' && req.method === 'GET') {
        json(200, {
          enabled: gwControl.enabled,
          port: gwControl.port,
          running: getGateway() !== undefined,
          error: gwState.gatewayError ?? null,
        })
        return
      }

      if (url.pathname === '/dsh-link/config/gateway' && req.method === 'POST') {
        const body = await readJson(req)
        const nextEnabled = typeof body['enabled'] === 'boolean' ? body['enabled'] : gwControl.enabled
        const rawPort = body['port']
        let nextPort = gwControl.port
        if (rawPort !== undefined) {
          const n = Number(rawPort)
          // 1024 以下需要 root；65535 以上不合法
          if (!Number.isInteger(n) || n < 1024 || n > 65535) {
            json(400, { error: '端口需为 1024–65535 之间的整数' })
            return
          }
          nextPort = n
        }

        const portChanged = nextPort !== gwControl.port
        gwControl.enabled = nextEnabled
        gwControl.port = nextPort
        await saveRuntime(LINK_DIR, {
          ...(relay.relayUrl === undefined ? {} : { relayUrl: relay.relayUrl }),
          gatewayEnabled: gwControl.enabled,
          gatewayPort: gwControl.port,
        })

        // 立即生效：开→起，关→停，改端口→重建
        if (!gwControl.enabled) {
          await gwControl.stop()
        } else if (getGateway() === undefined || portChanged) {
          if (portChanged) await gwControl.stop()
          await gwControl.start()
        }

        json(200, {
          ok: true,
          enabled: gwControl.enabled,
          port: gwControl.port,
          running: getGateway() !== undefined,
          error: gwState.gatewayError ?? null,
        })
        return
      }

      if (url.pathname === '/dsh-link/config/relay' && req.method === 'POST') {
        const body = await readJson(req)
        const next = typeof body['relayUrl'] === 'string' ? body['relayUrl'].trim() : ''

        // 空串 = 清除（回到只用局域网）
        if (next.length === 0) {
          relay.relayUrl = undefined
          await saveRuntime(LINK_DIR, { gatewayEnabled: gwControl.enabled, gatewayPort: gwControl.port })
          relay.endpoints = recomputeEndpoints()
          json(200, { ok: true, relayUrl: null, endpoints: relay.endpoints })
          return
        }

        // 只接受 ws:// 或 wss://：http 地址贴进来是最常见的误操作
        if (!/^wss?:\/\/[^\s]+$/.test(next)) {
          json(400, { error: '请填 ws:// 或 wss:// 开头的地址，例如 wss://dsh.example.com/dshlink' })
          return
        }

        relay.relayUrl = next
        await saveRuntime(LINK_DIR, { relayUrl: next, gatewayEnabled: gwControl.enabled, gatewayPort: gwControl.port })
        relay.endpoints = recomputeEndpoints()
        json(200, { ok: true, relayUrl: next, endpoints: relay.endpoints })
        return
      }

      // 设备重命名：界面上让用户给机器起名（"书房 Mac"），
      // 否则一堆 "dev_xxxx" 根本分不清哪台是哪台。
      if (url.pathname === '/dsh-link/pair/rename' && req.method === 'POST') {
        const body = await readJson(req)
        const deviceId = String(body['deviceId'] ?? '')
        const label = String(body['label'] ?? '').trim()
        if (label.length === 0 || label.length > 32) {
          json(400, { error: '名称需为 1-32 个字符' })
          return
        }
        const done = await devices?.rename(deviceId, label)
        json(done === true ? 200 : 404, done === true ? { ok: true, deviceId, label } : { error: '设备不存在' })
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
        getGateway()?.disconnectDevice(revoked)
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

/**
 * 启动网关，EADDRINUSE 时退避重试。
 *
 * 只对"端口被占用"重试：其它错误（权限、网卡异常）重试也没用，
 * 立刻交给调用方降级并打日志。
 */
async function startGatewayWithRetry(
  opts: Parameters<typeof startGateway>[0],
  ctx: { logger?: { warn?: (msg: string, ...args: unknown[]) => void } },
): Promise<Gateway> {
  const attempts = 6
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await startGateway(opts)
    } catch (error) {
      lastError = error
      const code = (error as { code?: string } | undefined)?.code
      if (code !== 'EADDRINUSE') throw error
      if (i < attempts - 1) {
        // 300ms 起，逐次 +200ms：给上一个进程释放端口的时间
        await new Promise((resolve) => setTimeout(resolve, 300 + i * 200))
      }
    }
  }
  ctx.logger?.warn?.('[dsh-link] 端口一直被占用，重试 %d 次后放弃', attempts)
  throw lastError
}
