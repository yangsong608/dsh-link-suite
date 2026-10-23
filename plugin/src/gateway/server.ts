/**
 * 网关：WSS 服务 + 连接管理 + 分发。
 *
 * 状态（M0 之后）：
 *   ✅ 帧收发、guard（锁屏与角色）、错误映射、心跳、断开清理、事件广播
 *   ✅ 设备令牌认证（pair.finish 拿到的 bearer token，sha256 建索引）
 *   ✅ 预认证白名单：device.info / lock.status / pair.start / pair.finish
 *   ✅ 准入闸门：建连限额、速率、帧上限、Origin 校验
 *   ⬜ 载荷级 E2E：留 `Aead` 接口，见 docs/02 §4.4
 *   ⬜ 中继与多通道竞速：见 docs/09
 *
 * 明确标注未实现的部分，比假装实现更安全：联调时一眼能看出缺口在哪。
 */

import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  decodeFrame,
  encodeFrame,
  hasRole,
  isMethod,
  METHOD_POLICY,
  RpcError,
  type DeviceRole,
  type Frame,
  type Method,
} from '@dsh-link/protocol'

import type { GatewayHandlers, RouteContext } from './router.js'
import { guardLock } from './guard.js'
import {
  AdmissionControl,
  checkOrigin,
  defaultAllowedOrigins,
  PRE_AUTH_TIMEOUT_MS,
} from './limits.js'

/**
 * 认证之前允许调用的方法。
 *
 * 这张表与 `LOCK_EXEMPT_METHODS` 是**两件不同的事**，不能合并：
 *   - 锁豁免 = 锁死时仍然可达（解锁本身）
 *   - 预认证 = 还没配对时也要能调（问主机是谁、发起配对）
 * 之前的实现只有一个认证判断，导致 device.info 与 pair.* 被一起挡掉，
 * 配对流程死锁——网关于是"除了 ping 什么都调不到"。
 */
const PRE_AUTH: ReadonlySet<Method> = new Set<Method>([
  'device.info',
  'lock.status',
  'pair.start',
  'pair.finish',
])

interface Conn {
  readonly id: string
  readonly ws: WebSocket
  readonly ip: string
  deviceId: string
  /** 配对时记录的展示名。 */
  label: string
  role: DeviceRole
  authenticated: boolean
  alive: boolean
  seq: number
  /** 未认证连接的超时计时器；认证成功或断开时清掉。 */
  preAuthTimer: ReturnType<typeof setTimeout> | undefined
}

export interface GatewayOptions {
  readonly rc: RouteContext
  readonly handlers: GatewayHandlers
  readonly port: number
  readonly host: string
  readonly heartbeatMs: number
  /** 额外允许的 Origin（dsh 自己的域名 / 反代地址）。 */
  readonly allowedOrigins?: readonly string[]
  /**
   * 允许被连接的本机地址（绑 0.0.0.0 时必填）。
   *
   * 没有它，监听会落到 VPN、docker、甚至公网网卡上。每次建连都用
   * `socket.localAddress` 重算，所以 DHCP 换地址后不需要重启。
   */
  readonly allowedLocalAddresses?: readonly string[]
}

export interface Gateway {
  readonly port: number
  close(): Promise<void>
  /** 广播给所有已认证连接（锁状态变化用它）。 */
  broadcast(method: string, payload: unknown): void
  /** 断开某台设备的全部在线连接（撤销用）。 */
  disconnectDevice(deviceId: string): number
  /**
   * 把一条连接升格为已认证（pair.finish 调用）。
   *
   * 放在网关接口上而不是让 router 直接改 Conn：Conn 是网关的私有状态，
   * 认证状态只能有一个写入口，否则"某条连接到底认证没有"会散落在两处。
   */
  authenticate(connId: string, deviceId: string, role: DeviceRole, label: string): boolean
  /** 向某条连接推一帧 evt（订阅分发用）。连接不存在时静默丢弃。 */
  sendEvent(connId: string, channel: string, method: string, payload: unknown): void
  /** 当前已认证的连接数。审批桥用它决定"要不要等手机回答"。 */
  readonly authenticatedConnections: number
  /** 某条连接属于哪台设备（审批归属校验用）。 */
  deviceOf(connId: string): string | undefined
  readonly connections: number
}

export async function startGateway(opts: GatewayOptions): Promise<Gateway> {
  const { rc, handlers, port, host, heartbeatMs, allowedLocalAddresses } = opts
  const allowedOrigins = [...defaultAllowedOrigins(), ...(opts.allowedOrigins ?? [])]
  const admission = new AdmissionControl()
  const conns = new Map<string, Conn>()
  let nextId = 0

  const http: Server = createServer((req, res) => {
    // 网关只服务 WSS；HTTP 面留给 dsh 的 webServer。
    // 这里回 426 是给"用浏览器误打开端口"的人一个明确答案，而不是超时。
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, connections: conns.size, tls: false }))
      return
    }
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8', upgrade: 'websocket' })
    res.end('DSH Link gateway speaks WebSocket only\n')
  })

  // noServer：由我们自己决定"哪些 upgrade 能完成握手"。
  // 用 `{ server: http }` 时 ws 会注册**自己的** upgrade 监听器，我们旁听时
  // 拒绝一个连接（destroy socket）之后它仍会照常完成握手——限速与 Origin
  // 校验于是变成"只写日志、不挡人"。noServer + handleUpgrade 是唯一可靠写法。
  const wss = new WebSocketServer({ noServer: true, path: '/dshlink' })

  /**
   * HTTP upgrade 阶段就把明显不该放的连接挡掉。
   *
   * 放在这里而不是 `connection` 事件之后：到这里还没分配任何连接对象、没注册
   * 任何监听器，拒绝的成本最低。Origin 与建连限额都在这一层判断。
   */
  http.on('upgrade', (req, socket, head) => {
    const ip = req.socket.remoteAddress ?? 'unknown'

    // ① 本机地址白名单：挡掉"连到了不该被连的网卡"这种情况。
    //    放在最前面，因为它是纯本地判断，不依赖任何请求内容。
    //
    //    回环永远放行：白名单只来自非回环网卡，而本机浏览器/调试客户端
    //    连的就是 127.0.0.1。少了这一句，绑 0.0.0.0 之后本机自己也连不上。
    const local = req.socket.localAddress
    const loopbackLocal = typeof local === 'string' && (local === '::1' || local.startsWith('127.'))
    if (
      allowedLocalAddresses !== undefined &&
      allowedLocalAddresses.length > 0 &&
      typeof local === 'string' &&
      !loopbackLocal &&
      !allowedLocalAddresses.includes(local)
    ) {
      rc.ctx.logger?.warn('[dsh-link] 拒绝连接：本机地址 %s 不在白名单', local)
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    if (!checkOrigin(req.headers.origin, allowedOrigins, req.headers.host)) {
      rc.ctx.logger?.warn('[dsh-link] 拒绝来源 %s（Origin %s）', ip, req.headers.origin ?? '?')
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    // 认证令牌：优先 Authorization 头，其次 query（浏览器 WebSocket 无法带自定义头）
    const authHeader = req.headers.authorization
    const bearer = typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : undefined
    const fromQuery = (() => {
      try {
        return new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? undefined
      } catch {
        return undefined
      }
    })()
    const presented = bearer ?? fromQuery
    const authenticated = presented === undefined ? undefined : rc.devices.authenticate(presented)

    const verdict = admission.admitConnection(ip)
    if (!verdict.ok) {
      rc.ctx.logger?.warn('[dsh-link] 拒绝连接 %s：%s', ip, verdict.reason)
      socket.write(`HTTP/1.1 ${String(verdict.code)} Too Many Requests\r\nConnection: close\r\n\r\n`)
      socket.destroy()
      // 必须 return：ws 的 upgrade 监听器是**独立注册**的，我们只是"旁听"。
      // 不 return 的话，后面的代码仍会把 socket 标记为已受理，而 ws 也会照常
      // 完成握手——限速就变成了只写日志、不挡人。
      return
    }
    // 三道闸门都过了：交给 ws 完成握手，并把认证信息随 socket 带过去。
    // 已经扣过额度，connection 事件里不再重复扣。
    wss.handleUpgrade(req, socket, head, (ws) => {
      // ws 的 connection 事件签名只声明 (ws, req)；认证信息用第三个参数带过去，
      // 由下方的监听器按 `KnownDevice | undefined` 读取。
      ;(wss.emit as (event: string, ...args: unknown[]) => boolean)('connection', ws, req, authenticated)
    })
  })

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

    if (!isMethod(method)) {
      fail(conn, frame.id, new RpcError('rpc/unknown', `未知方法 ${frame.m}`))
      return
    }
    const policy = METHOD_POLICY[method]
    if (policy === undefined) {
      fail(conn, frame.id, new RpcError('rpc/unknown', `未知方法 ${frame.m}`))
      return
    }

    try {
      // ① 锁：先于角色与认证判断。锁死时连"你有没有权限"都不该回答。
      guardLock(rc.lock.get(), method)

      // ② 认证：只有预认证白名单里的方法可以匿名调用
      if (!conn.authenticated && !PRE_AUTH.has(method)) {
        throw new RpcError('auth/need-pair', '连接尚未认证，请先配对')
      }

      // ③ 角色：预认证连接按 viewer 处理，白名单里的方法本来也是 viewer 级
      if (!hasRole(conn.role, policy.role)) {
        throw new RpcError('auth/forbidden', `需要 ${policy.role} 角色`)
      }

      // ④ 执行
      const handler = handlers[method]
      const result = await handler(rc, params, {
        deviceId: conn.deviceId,
        label: conn.label === '' ? undefined : conn.label,
        role: conn.role,
        remoteAddress: conn.ip,
        connId: conn.id,
      })

      // 任何一次成功调用都算活动（否则用户在手机上操作，PC 仍然会因为空闲而锁）
      rc.lock.touch()
      send(conn, { t: 'res', id: frame.id, ok: true, r: result })
    } catch (err) {
      fail(conn, frame.id, err)
    }
  }

  type KnownDevice = { deviceId: string; role: DeviceRole; label: string }
  const onConnection = (ws: WebSocket, req: import('node:http').IncomingMessage, known?: KnownDevice): void => {
    const ip = req.socket.remoteAddress ?? 'unknown'
    const conn: Conn = {
      id: `c_${nextId++}`,
      ws,
      ip,
      // 已配对设备带 token 重连：直接升格，不必再配对。
      deviceId: known?.deviceId ?? 'unpaired',
      label: known?.label ?? '',
      role: known?.role ?? 'viewer',
      authenticated: known !== undefined,
      alive: true,
      seq: 0,
      preAuthTimer: undefined,
    }
    conns.set(conn.id, conn)
    rc.ctx.logger?.info(
      '[dsh-link] 连接来自 %s（%s，%s）',
      ip,
      conn.id,
      conn.authenticated ? `已认证 ${conn.label}` : '未认证',
    )

    // 未认证连接不能无限期挂着（已认证连接不需要这个计时器）
    if (!conn.authenticated) conn.preAuthTimer = setTimeout(() => {
      if (conn.authenticated) return
      rc.ctx.logger?.info('[dsh-link] 未认证超时，断开 %s', conn.id)
      try {
        ws.close(1008, 'authentication timeout')
      } catch {
        /* 已断 */
      }
    }, PRE_AUTH_TIMEOUT_MS)
    conn.preAuthTimer?.unref?.()

    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString()
      // 帧上限在解析之前判断：一条超大帧不该被 JSON.parse 一遍再拒绝
      const sized = admission.checkFrame(Buffer.byteLength(raw, 'utf8'))
      if (!sized.ok) {
        rc.ctx.logger?.warn('[dsh-link] 帧超限 %s：%s', conn.id, sized.reason)
        try {
          ws.close(1009, 'frame too large')
        } catch {
          /* 已断 */
        }
        return
      }
      let frame: Frame
      try {
        frame = decodeFrame(raw)
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
      if (conn.preAuthTimer) clearTimeout(conn.preAuthTimer)
      conns.delete(conn.id)
      admission.releaseConnection(ip)
      rc.ctx.logger?.info('[dsh-link] 断开 %s', conn.id)
    })

    ws.on('error', (err) => {
      rc.ctx.logger?.warn('[dsh-link] socket 错误 %s: %s', conn.id, err.message)
    })

  }
  wss.on('connection', onConnection as never)

  /**
   * 供 pair.finish 使用：把一条连接升格为已认证。
   *
   * 放在网关内部而不是 router 里，是因为 Conn 是网关的私有状态——
   * router 只能通过这个函数改动它，避免认证状态散落在两处。
   */
  const authenticate = (connId: string, deviceId: string, role: DeviceRole, label: string): boolean => {
    const conn = conns.get(connId)
    if (conn === undefined) return false
    conn.deviceId = deviceId
    conn.role = role
    conn.label = label
    conn.authenticated = true
    if (conn.preAuthTimer) {
      clearTimeout(conn.preAuthTimer)
      conn.preAuthTimer = undefined
    }
    return true
  }

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
  rc.ctx.logger?.info('[dsh-link] gateway 监听 %s:%d（明文 WS）', host, actualPort)

  return {
    port: actualPort,
    get connections() {
      return conns.size
    },
    broadcast,
    sendEvent(connId, channel, method, payload) {
      const conn = conns.get(connId)
      if (conn === undefined) return
      send(conn, { t: 'evt', ch: channel, seq: conn.seq++, m: method, p: payload })
    },
    get authenticatedConnections() {
      let count = 0
      for (const conn of conns.values()) if (conn.authenticated) count += 1
      return count
    },
    deviceOf(connId) {
      const conn = conns.get(connId)
      return conn?.authenticated === true ? conn.deviceId : undefined
    },
    disconnectDevice(deviceId: string): number {
      let closed = 0
      for (const conn of conns.values()) {
        if (conn.deviceId !== deviceId) continue
        closed += 1
        try {
          conn.ws.close(1008, 'device revoked')
        } catch {
          /* 已断 */
        }
      }
      return closed
    },
    async close() {
      clearInterval(heartbeat)
      for (const conn of conns.values()) {
        if (conn.preAuthTimer) clearTimeout(conn.preAuthTimer)
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
    authenticate,
  }
}
