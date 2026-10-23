/**
 * 会话适配层：把 dsh 的 SessionController 输出压成 App 需要的形状。
 *
 * 为什么需要这一层，而不是让 RPC handler 直接透传：
 *   1. dsh 的返回值里有大量宿主内部字段（agent 对象、projection 基线、品牌类型），
 *      一旦泄漏进协议，dsh 小版本升级就会改到这里。
 *   2. App 只需要"能渲染的粗粒度块"。透传会让手机端承担解析负担，也更容易
 *      在某个字段为 undefined 时白屏。
 *   3. 归一化是纯函数，可以脱开宿主单独测试——这是本文件最大的价值。
 */

import type {
  SessionSummary as ProtocolSessionSummary,
  SessionStatus,
  StreamItem,
  TraceItem,
} from '@dsh-link/protocol'

/** dsh `SessionSummary` 中我们真正读取的字段（其余忽略）。 */
export interface HostSessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd?: string
  readonly projections?: { readonly title?: string; readonly status?: string }
}

/**
 * 会话状态推导。
 *
 * 优先级：running > 空会话 > 完成。dsh 的 `running` 是唯一可靠的实时信号；
 * `waiting-approval` / `waiting-input` 只能从事件流推断，所以这里不猜——
 * 让 trace 把审批卡片推给 UI，列表保持"运行中/空闲"两态。
 */
export function sessionStatus(summary: HostSessionSummary): SessionStatus {
  if (summary.running) return 'running'
  if (summary.blank) return 'idle'
  return 'done'
}

/** dsh 的 title 来自 projections；没有就退化成 cwd 的尾段。 */
export function sessionTitle(summary: HostSessionSummary): string {
  const projected = summary.projections?.title
  if (typeof projected === 'string' && projected.trim().length > 0) return projected
  const cwd = summary.cwd
  if (typeof cwd === 'string' && cwd.length > 0) {
    const parts = cwd.split(/[\\/]/).filter((p) => p.length > 0)
    return parts[parts.length - 1] ?? '未命名会话'
  }
  return '未命名会话'
}

export function toSessionSummary(summary: HostSessionSummary, workspaceId: string): ProtocolSessionSummary {
  return {
    id: summary.sessionId,
    workspaceId,
    title: sessionTitle(summary),
    status: sessionStatus(summary),
    updatedAt: summary.updatedAt,
  }
}

export function toSessionSummaries(items: readonly HostSessionSummary[], workspaceId: string): ProtocolSessionSummary[] {
  return items
    .filter((item) => typeof item?.sessionId === 'string' && item.sessionId.length > 0)
    .map((item) => toSessionSummary(item, workspaceId))
    // 最近更新的排在前面：手机列表只有一屏，顺序就是信息架构
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

// ── 事件 → TraceItem ──────────────────────────────────────────────────────

/**
 * dsh 会话事件的最小形状。
 *
 * 字段刻意全部可选：调用方拿到的是 unknown，归一化层必须自己判断，
 * 而不是相信"这个事件一定有 data.text"。dsh 加了新字段不会影响我们，
 * 删了字段我们也不会崩——只会少一帧。
 */
export interface HostSessionEvent {
  readonly type: string
  readonly seq?: number
  readonly at?: number
  readonly data?: Record<string, unknown>
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

/**
 * 归一化一条会话事件。
 *
 * 三条纪律：
 *   1. 认不出的事件返回 undefined（丢弃），**绝不抛错**——dsh 加事件类型比我们跟得快，
 *      抛错会让整条流断掉。
 *   2. 正文类字段截断（input 200 / output 400 / tail 40 行），完整内容留给 trace.detail。
 *   3. `redacted` 由调用方按锁状态填，这里只负责"把内容挖空"。
 */
export function toTraceItem(event: HostSessionEvent, redacted = false): TraceItem | undefined {
  const seq = event.seq
  if (typeof seq !== 'number') return undefined
  const at = typeof event.at === 'number' ? event.at : Date.now()
  const base = { seq, at, ...(redacted ? { redacted: true } : {}) }
  const data = event.data ?? {}

  switch (event.type) {
    case 'assistant/message': {
      const text = asString(data['text'])
      if (text === undefined) return undefined
      return { ...base, k: 'text', text: redacted ? '' : text.slice(0, 4000) }
    }

    case 'tool/call': {
      const tool = asString(data['toolName']) ?? asString(data['tool']) ?? 'tool'
      const target = asString(data['target'])
      const input = asString(data['input'])
      return {
        ...base,
        k: 'tool',
        tool,
        ...(target === undefined ? {} : { target }),
        ...(input === undefined || redacted ? {} : { input: input.slice(0, 200) }),
      }
    }

    case 'tool/result': {
      const tool = asString(data['toolName']) ?? asString(data['tool']) ?? 'tool'
      const output = asString(data['output'])
      const ok = data['ok'] === true ? true : data['ok'] === false ? false : undefined
      const ms = asNumber(data['ms'])
      return {
        ...base,
        k: 'tool',
        tool,
        ...(output === undefined || redacted ? {} : { output: output.slice(0, 400) }),
        ...(ok === undefined ? {} : { ok }),
        ...(ms === undefined ? {} : { ms }),
      }
    }

    case 'approval/asked': {
      const id = asString(data['id'])
      if (id === undefined) return undefined
      return {
        ...base,
        k: 'approval',
        id,
        cmd: asString(data['toolName']) ?? asString(data['cmd']) ?? '需要审批',
        ...(asString(data['reason']) === undefined ? {} : { risk: asString(data['reason']) as string }),
      }
    }

    case 'turn/start':
      return { ...base, k: 'note', text: '开始执行' }

    case 'turn/end': {
      // TraceKind 里没有 done（那是 StreamItem 的形状）。审计视角用 note 记一句，
      // 聊天流由 toStreamItem 依据 note 的前缀还原成 done 帧。
      const ok = data['ok'] === false ? false : true
      return { ...base, k: 'note', text: ok ? '本轮结束' : '本轮失败' }
    }

    case 'error': {
      const code = asString(data['code']) ?? 'host/internal'
      const msg = asString(data['message']) ?? asString(data['msg']) ?? '未知错误'
      return { ...base, k: 'error', code, msg: redacted ? '' : msg }
    }

    case 'session/title': {
      const title = asString(data['title'])
      if (title === undefined) return undefined
      return { ...base, k: 'note', text: `会话标题：${title}` }
    }

    default:
      // 未知事件静默丢弃。这是既定纪律：宁可少一帧，也不要断流。
      return undefined
  }
}

/**
 * 把 trace 条目投影成聊天流的一帧。
 *
 * 分工：TraceItem 是审计视角的超集，StreamItem 是聊天页要渲染的气泡。
 * 这里只挑能直接变成气泡的那几类，其余返回 undefined（详情页才展示）。
 */
export function toStreamItem(item: TraceItem): StreamItem | undefined {
  switch (item.k) {
    case 'text':
      return { k: 'assist', text: item.text, at: item.at, streaming: false }
    case 'tool':
      return {
        k: 'activity',
        tool: item.tool,
        summary: item.target ?? item.tool,
        ...(item.ms === undefined ? {} : { ms: item.ms }),
        ...(item.ok === undefined ? {} : { ok: item.ok }),
      }
    case 'approval':
      return { k: 'approval', id: item.id, cmd: item.cmd, ...(item.risk === undefined ? {} : { risk: item.risk }) }
    case 'note':
      // 只把"轮次结束"这类结构性 note 投影成 done；其它 note 不进聊天流。
      if (item.text === '本轮结束') return { k: 'done', at: item.at, ok: true }
      if (item.text === '本轮失败') return { k: 'done', at: item.at, ok: false }
      return undefined
    default:
      return undefined
  }
}
