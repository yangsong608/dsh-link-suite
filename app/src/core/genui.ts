/**
 * dsh-genui（`dsh-ui` fence）的解析与最小渲染契约。
 *
 * 插件在 PC 端把 fence 里的 JSON 渲染成可交互组件；手机端只能实现一个子集，
 * 但**必须实现**——否则 agent 输出的结构化内容（表格、指标、步骤）在手机上
 * 就是一坨 JSON。
 *
 * 设计原则（与 genui 一致）：
 *   - 白名单：只认已知 type，未知类型单条丢弃，不拖垮整块
 *   - 不执行任何脚本，只做展示
 *   - 解析失败 → 交给调用方降级成代码块，不丢内容
 */

export interface GenuiNode {
  readonly type: string
  readonly [key: string]: unknown
}

export interface GenuiSpec {
  readonly title?: string
  readonly gap?: number
  readonly items: readonly GenuiNode[]
}

/** 手机端已支持渲染的类型。其余整条跳过（并在末尾提示数量）。 */
export const SUPPORTED = new Set([
  'text',
  'list',
  'table',
  'keyvalue',
  'callout',
  'stat',
  'divider',
  'code',
  'json',
  'steps',
  'badge',
  'chart',
])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 解析一段 dsh-ui 的 JSON 文本。
 *
 * 返回 `undefined` 表示"这不是我们认得的结构"——调用方据此降级成代码块，
 * 而不是显示一个空壳。
 */
export function parseGenui(raw: string): { spec: GenuiSpec; skipped: number } | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(data)) return undefined
  const items = Array.isArray(data['items']) ? data['items'] : []
  if (items.length === 0) return undefined

  const kept: GenuiNode[] = []
  let skipped = 0
  for (const raw of items) {
    if (!isRecord(raw) || typeof raw['type'] !== 'string') { skipped += 1; continue }
    const node = raw as GenuiNode
    if (!SUPPORTED.has(node.type)) { skipped += 1; continue }
    kept.push(node)
  }

  return {
    spec: {
      ...(typeof data['title'] === 'string' ? { title: data['title'] } : {}),
      ...(typeof data['gap'] === 'number' ? { gap: data['gap'] } : {}),
      items: kept,
    },
    skipped,
  }
}

/** 取字符串字段（模板里不能直接对 unknown 做断言）。 */
export function str(node: GenuiNode, key: string): string {
  const v = node[key]
  return typeof v === 'string' ? v : ''
}

/** 取数字字段。 */
export function num(node: GenuiNode, key: string): number | undefined {
  const v = node[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 取数组字段。 */
export function arr(node: GenuiNode, key: string): readonly unknown[] {
  const v = node[key]
  return Array.isArray(v) ? v : []
}

export interface KeyValuePair { readonly key: string; readonly value: string }
export function pairs(node: GenuiNode): KeyValuePair[] {
  const out: KeyValuePair[] = []
  for (const raw of arr(node, 'pairs')) {
    if (!isRecord(raw)) continue
    out.push({
      key: String(raw['key'] ?? ''),
      value: String(raw['value'] ?? ''),
    })
  }
  return out
}

export interface TableData { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] }
export function table(node: GenuiNode): TableData | undefined {
  const columns = arr(node, 'columns').map((c) => String(c))
  const rawRows = arr(node, 'rows')
  if (columns.length === 0) return undefined
  const rows: string[][] = []
  for (const r of rawRows) {
    if (!Array.isArray(r)) continue
    rows.push(r.map((c) => String(c)))
  }
  return { columns, rows }
}

export interface ChartPoint { readonly label: string; readonly value: number }
export function chartPoints(node: GenuiNode): ChartPoint[] {
  const out: ChartPoint[] = []
  for (const raw of arr(node, 'data')) {
    if (!isRecord(raw)) continue
    const value = typeof raw['value'] === 'number' ? raw['value'] : Number(raw['value'])
    if (!Number.isFinite(value)) continue
    out.push({ label: String(raw['label'] ?? ''), value })
  }
  return out
}
