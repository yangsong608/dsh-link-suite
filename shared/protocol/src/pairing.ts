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
  // 归一化：扫码 SDK 会带尾部换行、BOM，也可能把 scheme 弄成大写。
  // 这些都不该让配对失败——用户看到的码是对的，失败必须是我们解析的问题。
  const text = raw.replace(/^\uFEFF/, '').trim()
  const lower = text.toLowerCase()
  const prefix = `${PAIR_SCHEME}://${PAIR_HOST}`
  if (!lower.startsWith(prefix)) return { ok: false, reason: 'not-pair-uri' }

  // 刻意**不用 new URL**：自定义 scheme 在各端 WebView 里行为不一致，
  // 某些实现会把 `dshlink://pair?...` 解析成 host=`pair?h=...` 或直接抛错。
  // 这里只做字符串切分，行为完全可预测。
  // 用 lower 切分而不是 text：scheme/host 可能被扫码 SDK 转成大写，
  // 但长度一致，所以按同一偏移切原文即可拿到原始 query
  const rest = lower.slice(prefix.length)
  const qIndex = rest.indexOf('?')
  const query = qIndex >= 0 ? rest.slice(qIndex + 1) : ''

  const params = new Map<string, string>()
  for (const pair of query.split('&')) {
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    try {
      params.set(key, decodeURIComponent(value))
    } catch {
      params.set(key, value)
    }
  }

  const host = (params.get('h') ?? '').trim()
  if (host.length === 0) return { ok: false, reason: 'missing-host' }

  const port = Number.parseInt((params.get('p') ?? '').trim(), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, reason: 'bad-port' }

  const code = (params.get('c') ?? '').trim()
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'bad-code' }

  const versionRaw = Number.parseInt(params.get('v') ?? '', 10)
  const version = Number.isInteger(versionRaw) ? versionRaw : PROTOCOL_VERSION
  const secure = params.get('s') === '1'
  const fingerprint = params.get('f') ?? undefined
  const pathRaw = params.get('path') ?? '/dshlink'
  const path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`

  const scheme = secure ? 'wss' : 'ws'
  // IPv6 地址要加方括号，否则拼出来的 URL 非法
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const wsUrl = `${scheme}://${hostPart}:${String(port)}${path}`

  return {
    ok: true,
    payload: {
      host,
      port,
      code,
      version,
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
