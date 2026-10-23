/**
 * 配对 URI：PC 生成的二维码内容，App 扫码后直接得到地址与配对码。
 *
 * 格式（自定义 scheme，避免被系统当成 http 链接打开浏览器）：
 *
 *   dshlink://pair?h=<host>&p=<port>&c=<code>&v=<version>&s=<wss 标记>&f=<指纹>
 *
 * 为什么不用 JSON 而是查询串：
 *   1. 短——二维码版本越低、码越稀疏，摄像头越好扫
 *   2. 扫码 SDK 普遍把内容当字符串回传，查询串用 URLSearchParams 一行解析
 *
 * 安全边界（重要）：
 *   二维码里**不含任何秘密**。配对码是一次性、2 分钟过期的短期凭证，
 *   而配对本身还需要 PC 侧确认。所以"被人拍照看到二维码"不等于"被配对成功"——
 *   攻击者拿到码之后仍需在 PC 前点确认。这是有意为之的纵深。
 */

import { PROTOCOL_VERSION } from './methods.js'

export const PAIR_SCHEME = 'dshlink'
export const PAIR_HOST = 'pair'

export interface PairPayload {
  /** 主机地址：域名或 IP（不带协议、不带端口） */
  readonly host: string
  readonly port: number
  /** 6 位配对码 */
  readonly code: string
  /** 协议版本，便于将来拒绝过期的二维码 */
  readonly version: number
  /** 是否走 TLS（true → wss://，false → ws://） */
  readonly secure: boolean
  /** 主机指纹：让用户在手机上比对"是不是这台机器" */
  readonly fingerprint?: string
  /** 路径。默认 /dshlink，反代改过路径时用得上 */
  readonly path?: string
}

/** 把配对信息编码成二维码内容。 */
export function encodePairUri(payload: PairPayload): string {
  const params = new URLSearchParams()
  params.set('h', payload.host)
  params.set('p', String(payload.port))
  params.set('c', payload.code)
  params.set('v', String(payload.version))
  if (payload.secure) params.set('s', '1')
  if (payload.fingerprint !== undefined) params.set('f', payload.fingerprint)
  if (payload.path !== undefined && payload.path !== '/dshlink') params.set('path', payload.path)
  return `${PAIR_SCHEME}://${PAIR_HOST}?${params.toString()}`
}

export type PairUriResult =
  | { readonly ok: true; readonly payload: PairPayload; readonly wsUrl: string }
  | { readonly ok: false; readonly reason: 'not-pair-uri' | 'missing-host' | 'bad-port' | 'bad-code' }

/**
 * 解析二维码内容。
 *
 * 失败时给出**具体原因**而不是笼统的 false：App 要能区分
 * "这不是配对码"（扫错了）和"码格式不对"（版本不兼容）。
 */
export function decodePairUri(raw: string): PairUriResult {
  const text = raw.trim()
  if (!text.toLowerCase().startsWith(`${PAIR_SCHEME}://${PAIR_HOST}`)) {
    return { ok: false, reason: 'not-pair-uri' }
  }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'not-pair-uri' }
  }

  const params = url.searchParams
  const host = params.get('h') ?? ''
  if (host.length === 0) return { ok: false, reason: 'missing-host' }

  const portRaw = params.get('p') ?? ''
  const port = Number.parseInt(portRaw, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, reason: 'bad-port' }

  const code = params.get('c') ?? ''
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'bad-code' }

  const version = Number.parseInt(params.get('v') ?? String(PROTOCOL_VERSION), 10)
  const secure = params.get('s') === '1'
  const fingerprint = params.get('f') ?? undefined
  const path = params.get('path') ?? '/dshlink'

  const scheme = secure ? 'wss' : 'ws'
  const wsUrl = `${scheme}://${host}:${String(port)}${path}`

  return {
    ok: true,
    payload: {
      host,
      port,
      code,
      version: Number.isInteger(version) ? version : PROTOCOL_VERSION,
      secure,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      path,
    },
    wsUrl,
  }
}

/** 由 ws 地址反推配对 URI 所需字段。宿主用它把监听信息变成二维码。 */
export function pairPayloadFromEndpoint(
  wsUrl: string,
  code: string,
  fingerprint?: string,
): PairPayload | undefined {
  let url: URL
  try {
    url = new URL(wsUrl)
  } catch {
    return undefined
  }
  const secure = url.protocol === 'wss:'
  const port = url.port === '' ? (secure ? 443 : 80) : Number.parseInt(url.port, 10)
  if (!Number.isInteger(port)) return undefined
  return {
    host: url.hostname,
    port,
    code,
    version: PROTOCOL_VERSION,
    secure,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    path: url.pathname,
  }
}
