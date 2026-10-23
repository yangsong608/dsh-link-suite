/**
 * 错误码。前缀是域，冒号后是原因。
 *
 * 原则：**客户端能据此决定"重试 / 提示 / 重新配对 / 去解锁"**。
 * 只写 "failed" 的错误码等于没写。
 */

export const ERROR_CODES = [
  // 协议层
  'rpc/unknown', // 方法不在白名单
  'rpc/bad-args', // zod 校验失败
  'rpc/too-large', // 单帧超 256KiB
  'rpc/timeout',

  // 鉴权
  'auth/forbidden', // 角色不足
  'auth/expired', // 票据过期
  'auth/revoked', // 设备被撤销
  'auth/need-pair', // 未配对
  'auth/bad-password',
  'auth/rate-limited',

  // 锁屏
  'lock/locked', // 已锁，除豁免方法全拒
  'lock/readonly', // 只读半锁，写操作被拒
  'lock/bad-password',
  'lock/rate-limited', // 尝试次数超限，带 retryAfterMs
  'lock/no-password-set',
  /** 本机允许已配对设备直接输密码解锁，远程审批这条路不适用（提示改用密码）。 */
  'lock/use-password',
  'lock/request-timeout',

  // 会话
  'session/busy',
  'session/not-found',
  'trace/not-found',

  // 消息队列：四种失败要能区分，否则 App 只能统一弹"发送失败"
  'queue/full', // 队列上限（默认 20 条）
  'queue/not-found', // 已发送或被别人删了
  'queue/immutable', // 已在发送中，不能编辑/重排

  // 文件
  'fs/escape', // 路径逃逸（工作区外）
  'fs/too-large',
  'fs/conflict', // 同名文件
  'fs/io',
  'fs/not-found',
  'fs/binary', // 试图按文本读二进制

  // 仓库与 git
  'git/not-a-repo',
  'git/no-path', // 路径不在该仓库内
  'git/unavailable', // 宿主机没装 git
  'git/too-large', // diff 超限且无法截断成有意义的片段
  'repo/unsupported', // caps.gh = 0 或没配 token
  'repo/auth', // GitHub token 失效

  // 插件
  'plugin/disabled', // 宿主未开启远程安装
  'plugin/not-found',
  'plugin/install-failed',

  // 宿主内部
  'host/unavailable',
  'host/internal',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface RpcErrorShape {
  readonly code: ErrorCode
  readonly msg: string
  /** 结构化补充：剩余次数、解锁时间、冲突文件名等。 */
  readonly details?: Record<string, unknown>
}

export class RpcError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: ErrorCode, msg: string, details?: Record<string, unknown>) {
    super(msg)
    this.name = 'RpcError'
    this.code = code
    this.details = details
  }

  toShape(): RpcErrorShape {
    return this.details === undefined
      ? { code: this.code, msg: this.message }
      : { code: this.code, msg: this.message, details: this.details }
  }
}

/** 客户端侧：错误码 → 该做什么。UI 只认这四类，不要为每个 code 写分支。 */
export type Recovery = 'retry' | 'toast' | 're-pair' | 'unlock'

export function recoveryFor(code: ErrorCode): Recovery {
  switch (code) {
    case 'rpc/timeout':
    case 'host/unavailable':
    case 'fs/io':
    case 'git/unavailable':
    case 'repo/auth':
      return 'retry'
    case 'auth/revoked':
    case 'auth/need-pair':
    case 'auth/expired':
      return 're-pair'
    case 'lock/locked':
    case 'lock/readonly':
      return 'unlock'
    // 只读半锁下"内容类"方法被拒时，唯一出路是去解锁——和 lock/readonly 同一处理，
    // 没解锁就别让用户反复点重试。
    case 'repo/unsupported':
      return 'toast'
    default:
      return 'toast'
  }
}
