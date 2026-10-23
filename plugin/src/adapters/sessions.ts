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
  /**
   * 投影块。真实结构是 { kind, asOfSeq, values: {...} }，
   * 标题在 values.title（来自 session/title 事件）。
   */
  readonly projections?: {
    readonly kind?: 'cached' | 'sequenced'
    readonly asOfSeq?: number
    readonly values?: Readonly<Record<string, unknown>>
  }
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
  /**
   * 真实标题在 `projections.values.title`，不是 `projections.title`。
   *
   * dsh 的结构是 SessionProjectionHints = { kind, asOfSeq, values: {...} }，
   * 标题是 values 里的一个键（来自 session/title 事件的投影）。
   * 之前少写了一层 values，导致永远取不到，退化成 cwd 尾段——
   * 于是所有会话都叫 "deepseek"（工作区目录名），和 dsh 里完全对不上。
   */
  const values = summary.projections?.values as Record<string, unknown> | undefined
  const projected = values?.['title']
  if (typeof projected === 'string' && projected.trim().length > 0) return projected
  // 兼容：有些版本可能把 title 平铺在 projections 上
  const flat = (summary.projections as { title?: unknown } | undefined)?.title
  if (typeof flat === 'string' && flat.trim().length > 0) return flat
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

/**
 * 从 content 块里拼出纯文字。
 *
 * 只取 type==='text' 的块：tool-call / image / file 各有自己的投影，
 * 硬塞进正文只会让回答变得难读。多块之间用空行分段。
 */
function collectText(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const raw of blocks) {
    const block = raw as { type?: unknown; text?: unknown }
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

/** 取 reasoning 块，用于折叠展示"它在想什么"。 */
function collectReasoning(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const raw of blocks) {
    const block = raw as { type?: unknown; text?: unknown }
    if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * 从工具参数里抽出"这一行该显示什么"。
 *
 * 目标：让 `▸ Bash  npm test` 这种一行能看懂，而不是 `▸ tool`。
 * 不同工具的参数字段不同，这里按常见约定猜，猜不到就返回 undefined（只显示工具名）。
 */
function toolTarget(tool: string, argsRaw: string): string | undefined {
  if (argsRaw.length === 0) return undefined
  let parsed: Record<string, unknown> | undefined
  try {
    const v: unknown = JSON.parse(argsRaw)
    if (typeof v === 'object' && v !== null) parsed = v as Record<string, unknown>
  } catch {
    // 不是 JSON：直接取第一行（有些工具传的是裸命令）
    const first = argsRaw.split('\n')[0]?.trim()
    return first !== undefined && first.length > 0 ? first.slice(0, 120) : undefined
  }
  if (parsed === undefined) return undefined

  const keys = ['command', 'cmd', 'path', 'file_path', 'pattern', 'query', 'url', 'prompt', 'description']
  for (const k of keys) {
    const v = parsed[k]
    if (typeof v === 'string' && v.trim().length > 0) {
      const oneLine = v.split('\n')[0]?.trim() ?? v
      return oneLine.slice(0, 120)
    }
  }
  // 认不出：用工具名占位，至少不显示一串 JSON
  return tool === 'tool' ? undefined : undefined
}

/** 从 ToolResultMessage 里取一句可读摘要（正文太长，只留开头）。 */
function extractResultSummary(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim()
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string' && text.trim().length > 0) {
          return text.replace(/\s+/g, ' ').trim()
        }
      }
    }
  }
  return undefined
}
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
    /*
     * assistant/message 的真实结构是
     *   { turn, step, message: AssistantMessage, stream, usage }
     * 文字在 message.content[] 的 text 块里，**不在 data.text**。
     * 之前读 data.text 永远是 undefined，于是 agent 的回答全被丢弃——
     * 这就是"会话里只有 bash，没有文字回答"的原因。
     *
     * reasoning 块单独投影成 think，不混进正文。
     */
    case 'assistant/message': {
      const message = data['message'] as { content?: unknown } | undefined
      const blocks = Array.isArray(message?.content) ? message.content : []
      const text = collectText(blocks)
      if (text.length === 0) {
        const think = collectReasoning(blocks)
        if (think.length > 0) return { ...base, k: 'think', summary: redacted ? '' : think.slice(0, 400) }
        return undefined
      }
      return { ...base, k: 'text', text: redacted ? '' : text.slice(0, 4000) }
    }

    // 用户自己说的话必须出现在历史里。
    // 之前的映射表漏了 user/message，导致回放历史时"我说过的话"全被丢弃，
    // 只剩 agent 的回复——看起来像会话不完整。
    // user/message 的 data 本身就是 UserMessage：{ id, role, content[], source }
    // 同样要读 content[]，读 data.text 会拿到 undefined。
    case 'user/message': {
      const blocks = Array.isArray(data['content']) ? data['content'] : []
      const text = collectText(blocks)
      if (text.length === 0) return undefined
      return { ...base, k: 'user', text: redacted ? '' : text.slice(0, 4000) }
    }

    /**
     * 工具调用。
     *
     * 真实字段是 `name` / `arguments`（见 dsh core/session 的 SessionEventMap），
     * 不是 toolName / input。之前取错字段，于是永远落到兜底值 'tool'——
     * 界面上就是一长串 `▸ tool`，看不出到底在干什么。
     *
     * 另外这里把 arguments 解析成"可读目标"：命令取第一行，文件取路径，
     * 让用户一眼知道"它在跑什么"，而不是看一串 JSON。
     */
    case 'tool/call': {
      const tool = asString(data['name']) ?? asString(data['toolName']) ?? 'tool'
      const argsRaw = asString(data['arguments']) ?? asString(data['input']) ?? ''
      const target = toolTarget(tool, argsRaw)
      return {
        ...base,
        k: 'tool',
        tool,
        phase: 'call',
        ...(target === undefined ? {} : { target }),
        ...(argsRaw.length === 0 || redacted ? {} : { input: argsRaw.slice(0, 200) }),
        // callId 用于把 result 合并回同一条
        ...(asString(data['callId']) === undefined ? {} : { callId: asString(data['callId']) as string }),
      }
    }

    /**
     * 工具结果。
     *
     * 真实结构是 { turn, step, message: ToolResultMessage, error?, meta? }。
     * 这里只抽取"成功/失败"与可读摘要，正文交给 trace.detail（未实现）。
     *
     * 带 callId 返回：上层据此**合并到对应的 tool/call 条目**，而不是再插一条。
     * 之前 call 与 result 各推一条，界面上就是"无数多个 tool"——
     * 一次工具调用变成两行，长会话里滚得看不到对话。
     */
    case 'tool/result': {
      const err = data['error'] as { reason?: unknown; code?: unknown } | undefined
      const ok = err === undefined
      const message = data['message'] as { content?: unknown } | undefined
      const summary = extractResultSummary(message)
      /**
       * tool/result 事件本身**不带工具名**（结构里只有 turn/step/message/error/meta）。
       * 所以这里给空串而不是 'tool'：上层按 callId 合并时保留 call 那条的名字，
       * 若 result 先到（少见），空串也不会覆盖掉已知的名字。
       */
      const nameFromMeta = asString((data['meta'] as { name?: unknown } | undefined)?.name)
      const nameFromData = asString(data['name']) ?? asString(data['toolName'])
      return {
        ...base,
        k: 'tool',
        phase: 'result',
        tool: nameFromMeta ?? nameFromData ?? '',
        ...(summary === undefined || redacted ? {} : { output: summary.slice(0, 400) }),
        ok,
        ...(asString(data['callId']) === undefined ? {} : { callId: asString(data['callId']) as string }),
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
        // summary 对 result 帧是空的（result 没有 target）——这是对的：
        // 客户端会把它合并到上一行，不覆盖已有的命令摘要
        summary: item.target ?? '',
        ...(item.ms === undefined ? {} : { ms: item.ms }),
        ...(item.ok === undefined ? {} : { ok: item.ok }),
        ...(item.callId === undefined ? {} : { callId: item.callId }),
        // phase 是合并的关键：没有它客户只会把 result 当成一条新行
        ...(item.phase === undefined ? {} : { phase: item.phase }),
      }
    case 'approval':
      return { k: 'approval', id: item.id, cmd: item.cmd, ...(item.risk === undefined ? {} : { risk: item.risk }) }
    case 'user':
      return { k: 'user', text: item.text, at: item.at }
    case 'note':
      // 只把"轮次结束"这类结构性 note 投影成 done；其它 note 不进聊天流。
      if (item.text === '本轮结束') return { k: 'done', at: item.at, ok: true }
      if (item.text === '本轮失败') return { k: 'done', at: item.at, ok: false }
      return undefined
    default:
      return undefined
  }
}
