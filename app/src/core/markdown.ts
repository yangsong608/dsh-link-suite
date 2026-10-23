/**
 * 极简 Markdown 解析。
 *
 * 为什么不引库：首包 400KB 是硬指标（docs/05 §8），marked/markdown-it 都是
 * 30KB+ 起步，而我们只需要 agent 回答里最常见的那几种结构。
 *
 * 支持（覆盖实际回答里 95% 的用法）：
 *   代码块 ```lang …… ```、行内 `code`、标题 ###、无序/有序列表、
 *   引用 >、分隔线 ---、加粗 **x**、斜体 *x*、链接 [文字](url)
 *
 * 刻意不做：表格、嵌套列表缩进、HTML 内联、脚注。
 * 这些在手机上要么读不清，要么是攻击面（HTML 必须转义）。
 *
 * 输出是**结构化块**而不是 HTML 字符串：uni-app 的 rich-text 对样式控制很弱，
 * 用它渲染代码块会丢失等宽字体与横向滚动。结构化后由组件用 view/text 自己画。
 */

export type Inline =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'code'; readonly v: string }
  | { readonly t: 'bold'; readonly v: string }
  | { readonly t: 'italic'; readonly v: string }
  | { readonly t: 'link'; readonly v: string; readonly href: string }

export type Block =
  | { readonly t: 'p'; readonly inline: readonly Inline[] }
  | { readonly t: 'h'; readonly level: 1 | 2 | 3; readonly inline: readonly Inline[] }
  | { readonly t: 'code'; readonly lang: string; readonly text: string }
  | { readonly t: 'ul'; readonly items: readonly (readonly Inline[])[] }
  | { readonly t: 'ol'; readonly items: readonly (readonly Inline[])[]; readonly start: number }
  | { readonly t: 'quote'; readonly inline: readonly Inline[] }
  | { readonly t: 'hr' }
  /**
   * `dsh-ui` fence（dsh-genui 插件的结构化 UI 规格）。
   *
   * 我们不实现它的 30+ 组件集，但也不能把几百行 JSON 当代码块糊在聊天里——
   * 那正是 genui README 说的"插件缺失时应优雅降级"的反面。这里单独成块，
   * 由渲染层给一张说明卡。
   */
  | { readonly t: 'genui'; readonly raw: string }

/** 解析行内标记。顺序很重要：代码优先，否则 `**` 之类会误判。 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = (): void => {
    if (buf.length > 0) { out.push({ t: 'text', v: buf }); buf = '' }
  }

  let i = 0
  while (i < src.length) {
    const ch = src[i]

    // 行内代码：`x`
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ t: 'code', v: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    // 加粗：**x**
    if (ch === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ t: 'bold', v: src.slice(i + 2, end) })
        i = end + 2
        continue
      }
    }

    // 斜体：*x*（排除 ** 的情况）
    if (ch === '*' && src[i + 1] !== '*') {
      const end = src.indexOf('*', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ t: 'italic', v: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    // 链接：[文字](url)
    if (ch === '[') {
      const close = src.indexOf(']', i + 1)
      const open = close >= 0 ? src.indexOf('(', close) : -1
      const done = open >= 0 ? src.indexOf(')', open) : -1
      if (close > i && open === close + 1 && done > open) {
        flush()
        out.push({ t: 'link', v: src.slice(i + 1, close), href: src.slice(open + 1, done) })
        i = done + 1
        continue
      }
    }

    buf += ch
    i += 1
  }

  flush()
  return out
}

const HEADING = /^(#{1,3})\s+(.*)$/
const UL = /^\s*[-*+]\s+(.*)$/
const OL = /^\s*(\d+)[.)]\s+(.*)$/
const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const FENCE = /^\s*```(.*)$/

/** 把 Markdown 文本解析成块。未知结构按普通段落处理，不丢内容。 */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // 代码块
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const lang = (fence[1] ?? '').trim()
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i += 1
      }
      // 跳过收尾的 ```
      if (i < lines.length) i += 1
      const text = body.join('\n')
      // dsh-ui：结构化 UI 规格，交给渲染层做降级说明，不按普通代码块处理
      if (lang.toLowerCase() === 'dsh-ui') {
        blocks.push({ t: 'genui', raw: text })
      } else {
        blocks.push({ t: 'code', lang, text })
      }
      continue
    }

    // 空行
    if (line.trim().length === 0) { i += 1; continue }

    // 分隔线
    if (HR.test(line)) { blocks.push({ t: 'hr' }); i += 1; continue }

    // 标题
    const h = HEADING.exec(line)
    if (h !== null) {
      const level = Math.min(3, (h[1] ?? '#').length) as 1 | 2 | 3
      blocks.push({ t: 'h', level, inline: parseInline(h[2] ?? '') })
      i += 1
      continue
    }

    // 引用（连续多行合并成一段，避免每行一个块）
    if (QUOTE.test(line)) {
      const parts: string[] = []
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        parts.push(QUOTE.exec(lines[i] ?? '')?.[1] ?? '')
        i += 1
      }
      blocks.push({ t: 'quote', inline: parseInline(parts.join('\n')) })
      continue
    }

    // 无序列表
    if (UL.test(line)) {
      const items: Inline[][] = []
      while (i < lines.length && UL.test(lines[i] ?? '')) {
        items.push(parseInline(UL.exec(lines[i] ?? '')?.[1] ?? ''))
        i += 1
      }
      blocks.push({ t: 'ul', items })
      continue
    }

    // 有序列表
    const ol0 = OL.exec(line)
    if (ol0 !== null) {
      const start = Number.parseInt(ol0[1] ?? '1', 10) || 1
      const items: Inline[][] = []
      while (i < lines.length && OL.test(lines[i] ?? '')) {
        items.push(parseInline(OL.exec(lines[i] ?? '')?.[2] ?? ''))
        i += 1
      }
      blocks.push({ t: 'ol', start, items })
      continue
    }

    // 普通段落：连续非空行合并（软换行在中文里通常是一个段落）
    const para: string[] = []
    while (i < lines.length) {
      const cur = lines[i] ?? ''
      if (cur.trim().length === 0) break
      if (FENCE.test(cur) || HEADING.test(cur) || UL.test(cur) || OL.test(cur) || QUOTE.test(cur) || HR.test(cur)) break
      para.push(cur)
      i += 1
    }
    if (para.length > 0) blocks.push({ t: 'p', inline: parseInline(para.join('\n')) })
    else i += 1
  }

  return blocks
}

/** 粗估是否含需要渲染的标记（纯文本就不用走解析，省一帧开销）。 */
export function looksLikeMarkdown(src: string): boolean {
  return /[`*#>_\-[]/.test(src) || src.includes('\n')
}
