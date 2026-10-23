/**
 * 从会话事件重建「本轮改了哪些文件」与「单文件差异」。
 *
 * 为什么不用 dsh 自带的 changes 接口：
 *   dsh 的 `/api/changes.summary` 与 `/api/changes.diff` 是 **owner-only HTTP 路由**，
 *   不是 `@Remote`。经网关接入的非 owner Peer 一律 403
 *   （client/connection/src/rpc-host.ts:218-222）。
 *
 * 所以这里走持久事件：`tool/result` 的 `data.meta.diffs` 是
 *   [{ path, oldText, newText }]
 * 由 write / edit 这类文件工具写入（core/tools/src/presentation.ts:34-40）。
 *
 * **这是近似结果，不是权威清单**：
 *   - 缺 shell 命令产生的文件改动（bash 写了文件不会出现在 meta.diffs 里）
 *   - 缺二进制 / 超大文件（它们没有文本差异）
 *   - 缺纯 git 操作（提交、删除、重命名）
 *   - 行数是自己按行比出来的，可能与 git 的 numstat 不同
 * 客户端必须把这件事告诉用户，不能假装是完整清单。
 */

export interface FileChange {
  readonly path: string
  /** add / mod / del —— 由 before/after 是否为空推断 */
  readonly op: 'add' | 'mod' | 'del'
  readonly additions: number
  readonly deletions: number
}

export interface FileDiffResult {
  readonly path: string
  readonly op: 'add' | 'mod' | 'del'
  readonly additions: number
  readonly deletions: number
  /** 旧内容（新增文件为空串） */
  readonly before: string
  /** 新内容（删除文件为空串） */
  readonly after: string
  /** 分块差异。手机上直接渲染 before/after 太长，这里给已经切好的行 */
  readonly hunks: readonly DiffLine[]
}

export interface DiffLine {
  readonly t: '+' | '-' | ' '
  readonly s: string
}

/** 一条 meta.diffs 记录（按出现顺序）。 */
interface DiffRecord {
  readonly path: string
  readonly before: string
  readonly after: string
}

/**
 * 从事件列表里抽出所有文件差异记录。
 *
 * 只认 `tool/result` 且 `data.meta.diffs` 是数组的形状；别的形状一律忽略
 * （dsh 会加新事件，遇到不认识的要安静跳过，不能让整页报错）。
 */
export function extractDiffRecords(events: readonly unknown[]): DiffRecord[] {
  const out: DiffRecord[] = []
  for (const raw of events) {
    const entry = raw as { type?: unknown; event?: { type?: unknown; data?: unknown } } | undefined
    if (entry?.type !== 'event') continue
    const ev = entry.event
    if (ev?.type !== 'tool/result') continue
    const data = ev.data as { meta?: unknown } | undefined
    const meta = data?.meta as { diffs?: unknown } | undefined
    const diffs = meta?.diffs
    if (!Array.isArray(diffs)) continue
    for (const d of diffs) {
      const item = d as { path?: unknown; oldText?: unknown; newText?: unknown }
      if (typeof item.path !== 'string' || item.path.length === 0) continue
      out.push({
        path: item.path,
        before: typeof item.oldText === 'string' ? item.oldText : '',
        after: typeof item.newText === 'string' ? item.newText : '',
      })
    }
  }
  return out
}

/**
 * 汇总成文件清单。
 *
 * 同一文件多次改动：以**最后一次**的 before/after 为准，
 * 行数也按最后那次算。理由：用户关心的是"最终变成什么样"，
 * 中间过程的增删行数对他没有意义（那不是他要验收的东西）。
 */
export function buildChanges(events: readonly unknown[]): FileChange[] {
  const latest = new Map<string, DiffRecord>()
  for (const rec of extractDiffRecords(events)) latest.set(rec.path, rec)

  const out: FileChange[] = []
  for (const [path, rec] of latest) {
    const stat = lineStat(rec.before, rec.after)
    out.push({ path, op: opOf(rec.before, rec.after), additions: stat.added, deletions: stat.deleted })
  }
  // 改动多的排前面：手机上先看到最值得看的
  return out.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
}

/** 取某个文件最近一次的差异。 */
export function latestDiffForPath(events: readonly unknown[], path: string): FileDiffResult | undefined {
  const records = extractDiffRecords(events).filter((r) => r.path === path)
  const last = records[records.length - 1]
  if (last === undefined) return undefined
  const stat = lineStat(last.before, last.after)
  return {
    path,
    op: opOf(last.before, last.after),
    additions: stat.added,
    deletions: stat.deleted,
    // 截断保护：文件可能很大，手机端不需要全文
    before: last.before.slice(0, 20_000),
    after: last.after.slice(0, 20_000),
    hunks: diffLines(last.before, last.after),
  }
}

function opOf(before: string, after: string): 'add' | 'mod' | 'del' {
  if (before.length === 0 && after.length > 0) return 'add'
  if (after.length === 0 && before.length > 0) return 'del'
  return 'mod'
}

/** 粗略行数统计（按行集合差，不做 LCS——手机上不需要精确到行号）。 */
function lineStat(before: string, after: string): { added: number; deleted: number } {
  const b = before.length === 0 ? [] : before.split('\n')
  const a = after.length === 0 ? [] : after.split('\n')
  const count = (lines: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const bc = count(b)
  const ac = count(a)
  let added = 0
  let deleted = 0
  for (const [line, n] of ac) {
    const old = bc.get(line) ?? 0
    if (n > old) added += n - old
  }
  for (const [line, n] of bc) {
    const now = ac.get(line) ?? 0
    if (n > now) deleted += n - now
  }
  return { added, deleted }
}

/**
 * 生成可渲染的差异行。
 *
 * 用最简单的"逐行对齐 + 相同行不动"策略：先找公共前缀/后缀，
 * 中间整段标成删除+新增。这比真正 LCS 粗糙，但：
 *   1. 手机上本来就看不清细粒度的行内对齐
 *   2. 不引 diff 库（首包预算 400KB 是硬指标）
 * 对"agent 改了这一段"这种判断完全够用。
 */
/** 差异行上限：再多手机上也读不完，而且会撑爆单帧大小。 */
const MAX_HUNK_LINES = 400

export function diffLines(before: string, after: string): DiffLine[] {
  const b = before.length === 0 ? [] : before.split('\n')
  const a = after.length === 0 ? [] : after.split('\n')
  // 截断也要覆盖这两条早返回：新文件/删除文件可能上万行
  if (b.length === 0) return a.slice(0, MAX_HUNK_LINES).map((s) => ({ t: '+', s }))
  if (a.length === 0) return b.slice(0, MAX_HUNK_LINES).map((s) => ({ t: '-', s }))

  let head = 0
  while (head < b.length && head < a.length && b[head] === a[head]) head++

  let tail = 0
  while (
    tail < b.length - head &&
    tail < a.length - head &&
    b[b.length - 1 - tail] === a[a.length - 1 - tail]
  ) tail++

  const out: DiffLine[] = []
  // 上下文收敛到 3 行（与 dsh 的 hunks 一致）
  const ctx = 3
  const headFrom = Math.max(0, head - ctx)
  for (let i = headFrom; i < head; i++) out.push({ t: ' ', s: b[i] ?? '' })
  for (let i = head; i < b.length - tail; i++) out.push({ t: '-', s: b[i] ?? '' })
  for (let i = head; i < a.length - tail; i++) out.push({ t: '+', s: a[i] ?? '' })
  const tailTo = Math.min(b.length, b.length - tail + ctx)
  for (let i = b.length - tail; i < tailTo; i++) out.push({ t: ' ', s: b[i] ?? '' })
  return out.slice(0, MAX_HUNK_LINES)
}
