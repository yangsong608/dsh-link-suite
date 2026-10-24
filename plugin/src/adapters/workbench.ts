/**
 * 工作台适配层：把 `wb.*` 方法翻译成对 dsh-workbench 的 loopback HTTP 调用。
 *
 * 为什么走 HTTP 而不是 `ctx.get('workbench')`：
 *   dsh-workbench 对外只暴露 `webServer` 上的 `/workbench-api` 前缀路由，
 *   没有注册成 cordis 服务。HTTP 是它**唯一**的稳定契约；去猜服务名会在
 *   它改内部结构时静默失效。而 loopback 调用与进程内调用一样不经过网络。
 *
 * 三条纪律：
 *   1. **只连回环**。地址永远从 webServer 的 origin 里取端口，主机名强制
 *      127.0.0.1 —— 不把工作台数据暴露到局域网，也不依赖 DNS。
 *   2. **不吞错误**。超时 / 连不上 / 非 2xx 各自映射成语义明确的 RpcError：
 *      客户端据此决定"重试"还是"这台机器没有工作台"，而不是统一弹"失败"。
 *   3. **探测是有缓存的**。`device.info` 每次连接都会问一次 caps，
 *      没有缓存就是每连一次打一次 HTTP；TTL 内复用结果，并且合并并发探测。
 */

import { randomUUID } from 'node:crypto'

import {
  RpcError,
  type WbChange,
  type WbDelta,
  type WbFocusInput,
  type WbFocusResult,
  type WbMeta,
  type WbPushResult,
} from '@dsh-link/protocol'
import type { DshContext, WebServerService } from '../dsh.js'

/** 工作台的 HTTP 前缀。与宿主约定一致，改这里必须同步改 dsh-workbench。 */
const PREFIX = '/workbench-api'

/** 默认超时：5s。工作台的数据都在本机，慢到这个程度基本就是卡死了。 */
const DEFAULT_TIMEOUT_MS = 5_000

/** 探测用的超时更短：它只决定 caps，不该拖慢 device.info 的响应。 */
const DEFAULT_PROBE_TIMEOUT_MS = 1_500

/** 探测结果缓存时长。宿主装/卸工作台是低频事件，15s 足够新了。 */
const DEFAULT_PROBE_TTL_MS = 15_000

export interface WbDeltaQuery {
  readonly since?: string
  readonly entity?: string
  readonly limit?: number
}

export interface WorkbenchOptions {
  /**
   * 覆盖 origin 解析（单测注入本地桩件用）。生产不传，走 webServer。
   * 返回 undefined 表示"宿主没有可用的 webServer"，此时方法统一抛 host/unavailable。
   */
  readonly origin?: (ctx: DshContext | undefined) => string | undefined
  readonly timeoutMs?: number
  readonly probeTimeoutMs?: number
  readonly probeTtlMs?: number
  /** 时钟注入（测缓存用）。 */
  readonly now?: () => number
}

export interface WorkbenchClient {
  /** 当前解析到的 loopback origin（`http://127.0.0.1:<port>`），不可用时 undefined。 */
  origin(ctx: DshContext | undefined): string | undefined
  meta(ctx: DshContext | undefined): Promise<WbMeta>
  delta(ctx: DshContext | undefined, query: WbDeltaQuery): Promise<WbDelta>
  push(ctx: DshContext | undefined, changes: readonly WbChange[]): Promise<WbPushResult>
  /** 全量快照：代理宿主 `GET /state`（只读，不解析内容）。 */
  state(ctx: DshContext | undefined): Promise<Record<string, unknown>>
  notesPut(ctx: DshContext | undefined, note: Record<string, unknown>): Promise<unknown>
  notesDelete(ctx: DshContext | undefined, id: string): Promise<unknown>
  /**
   * 记一次专注。
   *
   * 走 `POST /sync/push` 而不是另开一个 `/focus` 路由：`focus_sessions` 本来就是
   * 宿主的同步实体，推一条 upsert 就能落库 + 进入增量流，其它设备下一次 pull
   * 自然拿到。宿主没有 `/focus` 路由，去"发明"一个只会得到一个 404。
   */
  focusAdd(ctx: DshContext | undefined, input: WbFocusInput): Promise<WbFocusResult>
  /** `GET /news`：宿主一次返回 `{ topics, items }`。 */
  newsList(ctx: DshContext | undefined): Promise<unknown>
  /** 工作台是否可用（探测 `/sync/meta`）。永不抛错——它只回答是/否。 */
  probe(ctx: DshContext | undefined): Promise<boolean>
}

/**
 * 从 webServer 拿 loopback origin。
 *
 * `getOrigin()` 是 dsh 的公开面；个别版本只有 `port`，所以两条都试。
 * 主机名一律改写成 127.0.0.1：即使 dsh 监听 0.0.0.0 或绑了局域网地址，
 * 我们也不跟着它走——这是"只连回环"的唯一执行点。
 */
function originFromWebServer(ctx: DshContext | undefined): string | undefined {
  const ws = ctx?.get<WebServerService>('webServer', false)
  if (ws === undefined) return undefined

  let raw: string | undefined
  try {
    raw = typeof ws.getOrigin === 'function' ? ws.getOrigin() : undefined
  } catch {
    raw = undefined
  }

  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const url = new URL(raw)
      const scheme = url.protocol === 'https:' ? 'https:' : 'http:'
      const port = url.port !== '' ? url.port : scheme === 'https:' ? '443' : '80'
      return `${scheme}//127.0.0.1:${port}`
    } catch {
      // origin 不是合法 URL：落到 port 兜底
    }
  }

  const port = (ws as unknown as { port?: unknown }).port
  if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535) {
    return `http://127.0.0.1:${port}`
  }
  return undefined
}

export function createWorkbench(options: WorkbenchOptions = {}): WorkbenchClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const probeTtlMs = options.probeTtlMs ?? DEFAULT_PROBE_TTL_MS
  const now = options.now ?? (() => Date.now())
  const resolveOrigin = options.origin ?? originFromWebServer

  /** 探测缓存：一次只记一个 origin 的结果（同一宿主进程只有一个 webServer）。 */
  let probeCache: { origin: string; at: number; ok: boolean } | undefined
  let probePending: { origin: string; promise: Promise<boolean> } | undefined

  const requireOrigin = (ctx: DshContext | undefined): string => {
    const origin = resolveOrigin(ctx)
    if (origin === undefined) {
      throw new RpcError('host/unavailable', '宿主没有可用的 webServer，工作台能力不可用')
    }
    return origin
  }

  /**
   * 发一次请求并解析 JSON。
   *
   * 错误映射（客户端据此决定行为）：
   *   - 拿不到端口          → host/unavailable（能力不存在，重试无意义）
   *   - 超时 / 连不上       → host/unavailable（可重试，宿主可能刚重启）
   *   - 404 / 501 / 502/503 → host/unavailable（工作台没装或接口未实现）
   *   - 其它非 2xx          → host/internal（宿主自己出错，带状态码与服务端消息）
   *   - 2xx 但不是合法 JSON → host/internal
   */
  const request = async (
    ctx: DshContext | undefined,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutOverride?: number,
  ): Promise<unknown> => {
    const origin = requireOrigin(ctx)
    const url = `${origin}${PREFIX}${path}`
    const ms = timeoutOverride ?? timeoutMs
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, ms)

    let res: Response
    let text = ''
    // 先声明：连接成功但读 body 中断时，错误消息要能区分"没连上"与"断了"
    let responded = false
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        // loopback 上的跳转不可能是我们的路由；跟过去只会掩盖配置错误
        redirect: 'error',
      })
      responded = true
      // 读 body 也在超时窗口内：只等响应头、不等响应体，等于超时形同虚设
      text = await res.text()
    } catch (error) {
      if (timedOut) {
        throw new RpcError('host/unavailable', `工作台接口超时（${String(ms)}ms）：${method} ${path}`)
      }
      const message = error instanceof Error ? error.message : String(error)
      const what = responded ? '工作台接口响应中断' : '连不上工作台接口'
      throw new RpcError('host/unavailable', `${what}（${method} ${path}）：${message}`)
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const serverMessage = extractError(text)
      if (res.status === 404 || res.status === 501 || res.status === 502 || res.status === 503) {
        throw new RpcError(
          'host/unavailable',
          `工作台接口不可用（HTTP ${String(res.status)} ${method} ${path}）${serverMessage === '' ? '' : `：${serverMessage}`}`,
        )
      }
      throw new RpcError(
        'host/internal',
        `工作台接口报错（HTTP ${String(res.status)} ${method} ${path}）${serverMessage === '' ? '' : `：${serverMessage}`}`,
        { status: res.status },
      )
    }

    if (text.trim().length === 0) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new RpcError('host/internal', `工作台接口返回的不是 JSON（${method} ${path}）`)
    }
  }

  const query = (params: Record<string, string | number | undefined>): string => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      if (typeof value === 'string' && value.length === 0) continue
      search.set(key, String(value))
    }
    const encoded = search.toString()
    return encoded.length === 0 ? '' : `?${encoded}`
  }

  const asObject = (value: unknown, path: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new RpcError('host/internal', `工作台接口返回的形状不对（${path}）`)
    }
    return value as Record<string, unknown>
  }

  const client: WorkbenchClient = {
    origin: (ctx) => resolveOrigin(ctx),

    async meta(ctx) {
      const body = await request(ctx, 'GET', '/sync/meta')
      const obj = asObject(body, '/sync/meta')
      return obj as unknown as WbMeta
    },

    async delta(ctx, q) {
      const suffix = query({ since: q.since, entity: q.entity, limit: q.limit })
      const body = await request(ctx, 'GET', `/sync/delta${suffix}`)
      const obj = asObject(body, '/sync/delta')
      if (!Array.isArray(obj['changes'])) {
        throw new RpcError('host/internal', '工作台接口返回的 delta 缺少 changes 数组')
      }
      return obj as unknown as WbDelta
    },

    async push(ctx, changes) {
      const body = await request(ctx, 'POST', '/sync/push', { changes })
      const obj = asObject(body, '/sync/push')
      return obj as unknown as WbPushResult
    },

    async state(ctx) {
      return asObject(await request(ctx, 'GET', '/state'), '/state')
    },

    // 宿主的路由是 `POST /notes`（body `{ note }`）与 `DELETE /notes/:id`
    async notesPut(ctx, note) {
      return request(ctx, 'POST', '/notes', { note })
    },

    async notesDelete(ctx, id) {
      return request(ctx, 'DELETE', `/notes/${encodeURIComponent(id)}`)
    },

    async focusAdd(ctx, input) {
      const id = `f_${randomUUID()}`
      const startedAt = hostStamp()
      const change: WbChange = {
        entity: 'focus_sessions',
        id,
        op: 'upsert',
        updatedAt: startedAt,
        row: {
          id,
          taskId: input.taskId,
          startedAt,
          minutes: input.minutes,
          completed: input.completed,
        },
      }
      const result = await client.push(ctx, [change])
      return {
        id,
        startedAt,
        accepted: result.accepted.includes(id),
        conflicts: result.conflicts,
      }
    },

    async newsList(ctx) {
      return request(ctx, 'GET', '/news')
    },

    async probe(ctx) {
      let origin: string | undefined
      try {
        origin = resolveOrigin(ctx)
      } catch {
        return false
      }
      if (origin === undefined) return false

      const at = now()
      if (probeCache !== undefined && probeCache.origin === origin && at - probeCache.at < probeTtlMs) {
        return probeCache.ok
      }
      if (probePending !== undefined && probePending.origin === origin) return probePending.promise

      const promise = (async (): Promise<boolean> => {
        try {
          await request(ctx, 'GET', '/sync/meta', undefined, probeTimeoutMs)
          return true
        } catch {
          // 探测只回答"能不能用"。把错误吞在这里是**有意的**：
          // device.info 不该因为工作台没装就整条失败。
          return false
        }
      })()

      probePending = { origin, promise }
      try {
        const ok = await promise
        probeCache = { origin, at: now(), ok }
        return ok
      } finally {
        probePending = undefined
      }
    },
  }

  return client
}

/**
 * 与宿主一致的时间戳：`YYYY-MM-DD HH:MM:SS`（本地时间）。
 *
 * 不能直接用 `toISOString()`：宿主的 LWW 与游标都是**字符串比较**，
 * `T`/`Z` 会改变排序（`"T"` > `" "`），推上去的时间会被误判成永远最新。
 */
function hostStamp(at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${String(at.getFullYear())}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`
}

/** 从错误响应里抠一条人能读的消息；抠不到就返回空串。 */
function extractError(text: string): string {
  if (text.trim().length === 0) return ''
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    for (const key of ['message', 'error', 'msg'] as const) {
      const value = parsed[key]
      if (typeof value === 'string' && value.length > 0) return value.slice(0, 200)
    }
  } catch {
    // 非 JSON 错误体：退化成截断后的原文
  }
  return text.trim().slice(0, 200)
}
