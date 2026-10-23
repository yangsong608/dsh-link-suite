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
import { createHandlers } from './gateway/router.js'
import { startGateway, type Gateway } from './gateway/server.js'

export const name = 'dsh-link'

/**
 * 刻意留空：全部软读。
 * 声明 inject 会让"没装 webServer 的 profile"直接激活失败——而这个插件在没有它时
 * 仍然可以提供锁屏，只是没有 HTTP 状态接口。
 */
export const inject: string[] = []

const LINK_DIR = join(homedir(), '.dsh', 'dsh-link')

/** 取本机局域网 IPv4：跳过回环与 IPv6 链路本地。绑 0.0.0.0 是被 dsh 明确拒绝的做法。 */
function lanAddress(): string | undefined {
  const ifaces = networkInterfaces()
  const candidates: string[] = []
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      candidates.push(info.address)
    }
  }
  // 优先常见私网段，避免选到虚拟网卡（docker0 / vmnet / utun）
  const prefer = candidates.find((ip) => /^192\.168\./.test(ip)) ?? candidates.find((ip) => /^10\./.test(ip))
  return prefer ?? candidates[0]
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

  // ── 网关 ────────────────────────────────────────────────────────────────
  let gateway: Gateway | undefined
  const rc = { ctx, cfg, lock, hostId, dshVersion }

  if (cfg.gateway.enabled) {
    const host = bindHost(cfg.gateway.bind, lanAddress())
    gateway = await startGateway({
      rc,
      handlers: createHandlers(),
      port: cfg.gateway.port,
      host,
      heartbeatMs: cfg.gateway.heartbeatMs,
    })
    // 锁状态一变，立刻推给所有在线设备（App 不用轮询）
    ctx.on('dsh-link/lock-changed', (state) => {
      gateway?.broadcast('lock.changed', state as LockState)
    })
  }

  // ── 本机 HTTP 面（给浏览器里的锁屏层用）─────────────────────────────────
  const webServer = ctx.get<WebServerService>('webServer', false)
  if (webServer !== undefined) {
    const off = webServer.register({
      kind: 'prefix',
      path: '/dsh-link',
      handler: makeHttpHandler(lock, gateway),
    })
    ctx.effect(() => () => off(), 'dsh-link: http routes')
  }

  ctx.effect(
    () => () => {
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
function makeHttpHandler(lock: LockService, gateway: Gateway | undefined) {
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
      if (url.pathname === '/dsh-link/lock' && req.method === 'GET') {
        json(200, { ...lock.get(), armed: lock.armed, connections: gateway?.connections ?? 0 })
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

      if (url.pathname === '/dsh-link/lock/request' && req.method === 'POST') {
        const body = await readJson(req)
        const deviceId = String(body['deviceId'] ?? '')
        const approved = body['approved'] === true
        json(200, { settled: lock.settleRemote(deviceId, approved) })
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
