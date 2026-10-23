/**
 * App 端传输层。
 *
 * 一连接多通道：所有方法调用共用一条 WebSocket，靠 id 复用（docs/02 §3.4）。
 * 重连用"连续失败退避"而不是固定间隔——断网时固定 1s 重试会让手机发热。
 *
 * 本版是骨架：明文 WS。E2E 加密封装留在 `cipher` 钩子上（未实现，见 docs/02 §4.4）。
 */

import { decodeFrame, encodeFrame, RpcError, recoveryFor, type Frame, type Method } from '@dsh-link/protocol'

export type LinkStatus = 'offline' | 'connecting' | 'online' | 'needs-auth'

export interface LinkEndpoint {
  readonly url: string
  readonly kind: 'lan' | 'relay' | 'tailscale' | 'custom'
  /**
   * 配对拿到的 bearer token。
   *
   * 放在 endpoint 里而不是单独一个字段：它和地址是同一件事的两半——
   * 地址说"连哪台机器"，令牌说"凭什么连"。分开传会出现"连对了但没认证"的半成品状态。
   */
  readonly token?: string
}

type Listener = (payload: unknown) => void

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class Link {
  #sock: UniApp.SocketTask | undefined
  #pending = new Map<number, Pending>()
  #listeners = new Map<string, Set<Listener>>()
  #nextId = 1
  #status: LinkStatus = 'offline'
  #attempt = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #closed = false
  #onStatus: ((s: LinkStatus) => void) | undefined

  constructor(readonly endpoint: LinkEndpoint) {}

  get status(): LinkStatus {
    return this.#status
  }

  get lastSeq(): number {
    return this.#nextId
  }

  onStatusChange(cb: (s: LinkStatus) => void): void {
    this.#onStatus = cb
  }

  connect(): void {
    if (this.#closed || this.#sock !== undefined) return
    this.#setStatus('connecting')

    // 令牌走 query 参数：浏览器/uni-app 的 WebSocket 无法设置 Authorization 头。
    // 代价是令牌会出现在宿主日志的 URL 里，所以宿主侧日志必须脱敏（已做）。
    const url = this.endpoint.token === undefined
      ? this.endpoint.url
      : `${this.endpoint.url}${this.endpoint.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.endpoint.token)}`

    const sock = uni.connectSocket({
      url,
      // 子协议表明版本；服务端据此拒绝不兼容客户端，而不是让它们握上手再出错
      protocols: ['dshlink.v1'],
      complete: () => {},
    })

    this.#sock = sock

    sock.onOpen(() => {
      this.#attempt = 0
      this.#setStatus('online')
    })

    sock.onMessage((res) => {
      const data = res.data
      if (typeof data !== 'string') return
      let frame: Frame
      try {
        frame = decodeFrame(data)
      } catch {
        return
      }
      this.#dispatch(frame)
    })

    sock.onClose(() => {
      this.#sock = undefined
      this.#failAllPending(new RpcError('host/unavailable', '连接已断开'))
      if (this.#closed) return
      this.#setStatus('offline')
      this.#scheduleReconnect()
    })

    sock.onError(() => {
      // onError 之后通常还有 onClose，这里只记录，不重复重连
      this.#setStatus('offline')
    })
  }

  #scheduleReconnect(): void {
    if (this.#closed) return
    this.#attempt++
    // 1s → 2s → 4s → 8s → 封顶 30s，加 ±20% 抖动避免多设备同频重连
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.#attempt - 1, 5))
    const jitter = base * (0.8 + Math.random() * 0.4)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      this.connect()
    }, jitter)
  }

  #setStatus(s: LinkStatus): void {
    if (this.#status === s) return
    this.#status = s
    this.#onStatus?.(s)
  }

  #dispatch(frame: Frame): void {
    if (frame.t === 'res') {
      const pending = this.#pending.get(frame.id)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.#pending.delete(frame.id)
      if (frame.ok) pending.resolve(frame.r)
      else pending.reject(new RpcError(frame.e.code, frame.e.msg, frame.e.details))
      return
    }

    if (frame.t === 'evt') {
      const set = this.#listeners.get(frame.m)
      if (set === undefined) return
      for (const cb of set) {
        try {
          cb(frame.p)
        } catch {
          // 单个监听器抛错不影响其它监听器
        }
      }
      return
    }

    if (frame.t === 'ping') {
      this.#send({ t: 'pong', ts: frame.ts })
      return
    }

    if (frame.t === 'bye') {
      this.#closed = true
      this.#setStatus('offline')
    }
  }

  #failAllPending(err: Error): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.#pending.clear()
  }

  #send(frame: Frame): boolean {
    const sock = this.#sock
    if (sock === undefined) return false
    try {
      sock.send({ data: encodeFrame(frame) })
      return true
    } catch {
      return false
    }
  }

  /**
   * 调用一个方法。错误按 `recoveryFor` 分类：
   * retry（网络）→ 由调用方重试；unlock（锁定）→ 弹解锁层；re-pair → 重新配对。
   */
  async call<T = unknown>(method: Method, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    if (this.#sock === undefined) {
      throw new RpcError('host/unavailable', '尚未连接主机')
    }
    const id = this.#nextId++

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new RpcError('rpc/timeout', `调用 ${method} 超时`))
      }, timeoutMs)

      this.#pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      })

      const ok = this.#send({ t: 'req', id, m: method, p: params })
      if (!ok) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new RpcError('host/unavailable', '发送失败'))
      }
    })
  }

  on(event: string, cb: Listener): () => void {
    let set = this.#listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(cb)
    return () => {
      set?.delete(cb)
    }
  }

  close(): void {
    this.#closed = true
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    this.#failAllPending(new RpcError('host/unavailable', '已主动断开'))
    try {
      this.#sock?.close({ code: 1000 })
    } catch {
      /* 已断 */
    }
    this.#sock = undefined
    this.#setStatus('offline')
  }
}

/** 给 UI 用：错误 → 该做什么。避免每个页面各写一遍 switch。 */
export function handleError(err: unknown): { action: 'retry' | 'toast' | 're-pair' | 'unlock'; message: string } {
  if (err instanceof RpcError) {
    return { action: recoveryFor(err.code), message: err.message }
  }
  return { action: 'toast', message: err instanceof Error ? err.message : String(err) }
}
