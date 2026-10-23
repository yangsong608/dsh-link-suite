/**
 * 网关：WSS 服务 + 连接管理 + 分发。
 *
 * 本版只做**可跑通的骨架**：
 *   ✅ 帧收发、guard（锁屏与角色）、错误映射、心跳、断开清理、事件广播
 *   ⬜ 加密握手（E2E）：留 `seal/open` 接口，见 docs/02 §4.4
 *   ⬜ 设备身份认证：目前按"未认证 viewer"处理，见 docs/02 §3.1
 *
 * 明确标注未实现的部分，比假装实现更安全：M1 联调时一眼能看出缺口在哪。
 */

import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  decodeFrame,
  encodeFrame,
  hasRole,
  METHOD_POLICY,
  RpcError,
  type DeviceRole,
  type Frame,
  type Method,
} from '@dsh-link/protocol'

import type { GatewayHandlers, RouteContext } from './router.js'
import { guardLock } from './guard.js'

interface Conn {
  readonly id: string
  readonly ws: WebSocket
  deviceId: string
  role: DeviceRole
  authenticated: boolean
  alive: boolean
  seq: number
}

export interface GatewayOptions {
  readonly rc: RouteContext
  readonly handlers: GatewayHandlers
  readonly port: number
  readonly host: string
  readonly heartbeatMs: number
}

export interface Gateway {
  readonly port: number
  close(): Promise<void>
  /** 广播给所有已认证连接（锁状态变化用它）。 */
  broadcast(method: string, payload: unknown): void
  readonly connections: number
}

export async function startGateway(opts: GatewayOptions): Promise<Gateway> {
  const { rc, handlers, port, host, heartbeatMs } = opts
  const conns = new Map<string, Conn>()
  let nextId = 0

  const http: Server = createServer((req, res) => {
    // 网关只服务 WSS；HTTP 面留给 dsh 的 webServer。
    // 这里回 426 是给"用浏览器误打开端口"的人一个明确答案，而不是超时。
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, connections: conns.size }))
      return
    }
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8', upgrade: 'websocket' })
    res.end('DSH Link gateway speaks WebSocket only\n')
  })

  const wss = new WebSocketServer({ server: http, path: '/dshlink' })

  const send = (conn: Conn, frame: Frame): void => {
    if (conn.ws.readyState !== conn.ws.OPEN) return
    try {
      conn.ws.send(encodeFrame(frame))
    } catch {
      // 写失败说明连接已坏，close 事件会接手清理
    }
  }

  const broadcast = (method: string, payload: unknown): void => {
    for (const conn of conns.values()) {
      if (!conn.authenticated) continue
      send(conn, { t: 'evt', ch: 'ctl', seq: conn.seq++, m: method, p: payload })
    }
  }

  const fail = (conn: Conn, id: number, err: unknown): void => {
    if (err instanceof RpcError) {
      send(conn, { t: 'res', id, ok: false, e: err.toShape() })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    // 内部错误不把堆栈发给客户端，只给一个泛化 msg；细节进宿主日志。
    rc.ctx.logger?.error('[dsh-link] handler error:', err)
    send(conn, { t: 'res', id, ok: false, e: { code: 'host/internal', msg: message } })
  }

  const handle = async (conn: Conn, frame: Frame): Promise<void> => {
    if (frame.t === 'ping') {
      send(conn, { t: 'pong', ts: frame.ts })
      return
    }
    if (frame.t !== 'req') return

    const method = frame.m as Method
    const params = (frame.p ?? {}) as Record<string, unknown>

    const policy = METHOD_POLICY[method]
    if (policy === undefined) {
      fail(conn, frame.id, new RpcError('rpc/unknown', `未知方法 ${frame.m}`))
      return
    }

    try {
      // ① 锁：先于角色判断。锁死时连"你有没有权限"都不该回答。
      guardLock(rc.lock.get(), method)

      // ② 角色
      if (!conn.authenticated) {
        throw new RpcError('auth/need-pair', '连接尚未认证，请先配对')
      }
      if (!hasRole(conn.role, policy.role)) {
        throw new RpcError('auth/forbidden', `需要 ${policy.role} 角色`)
      }

      // ③ 执行
      const handler = handlers[method]
      const result = await handler(rc, params, {
        deviceId: conn.deviceId,
        role: conn.role,
        remoteAddress: '',
      })

      // 任何一次成功调用都算活动（否则用户在手机上操作，PC 仍然会因为空闲而锁）
      rc.lock.touch()
      send(conn, { t: 'res', id: frame.id, ok: true, r: result })
    } catch (err) {
      fail(conn, frame.id, err)
    }
  }

  wss.on('connection', (ws, req) => {
    const conn: Conn = {
      id: `c_${nextId++}`,
      ws,
      deviceId: 'unpaired',
      role: 'viewer',
      authenticated: false,
      alive: true,
      seq: 0,
    }
    conns.set(conn.id, conn)
    rc.ctx.logger?.info('[dsh-link] 连接来自 %s（%s）', req.socket.remoteAddress ?? '?', conn.id)

    ws.on('message', (data) => {
      let frame: Frame
      try {
        frame = decodeFrame(typeof data === 'string' ? data : data.toString())
      } catch {
        ws.close(1002, 'bad frame')
        return
      }
      void handle(conn, frame)
    })

    ws.on('pong', () => {
      conn.alive = true
    })

    ws.on('close', () => {
      conns.delete(conn.id)
      rc.ctx.logger?.info('[dsh-link] 断开 %s', conn.id)
    })

    ws.on('error', (err) => {
      rc.ctx.logger?.warn('[dsh-link] socket 错误 %s: %s', conn.id, err.message)
    })
  })

  // 心跳：两个周期无 pong 即断开。反代吞掉空闲连接时这是唯一能发现的手段。
  const heartbeat = setInterval(() => {
    for (const conn of conns.values()) {
      if (!conn.alive) {
        conn.ws.terminate()
        continue
      }
      conn.alive = false
      conn.ws.ping()
      send(conn, { t: 'ping', ts: Date.now() })
    }
  }, heartbeatMs)
  heartbeat.unref?.()

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      http.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      http.off('error', onError)
      resolve()
    }
    http.once('error', onError)
    http.once('listening', onListening)
    http.listen(port, host)
  })

  const addr = http.address()
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port
  rc.ctx.logger?.info('[dsh-link] gateway 监听 %s:%d', host, actualPort)

  return {
    port: actualPort,
    get connections() {
      return conns.size
    },
    broadcast,
    async close() {
      clearInterval(heartbeat)
      for (const conn of conns.values()) {
        try {
          conn.ws.close(1001, 'host shutting down')
        } catch {
          // 已经断了就忽略
        }
      }
      conns.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}
