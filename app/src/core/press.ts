/**
 * 按下反馈。
 *
 * 为什么需要它：uni-app 的 `:active` 在某些平台只在点按的瞬间生效，
 * 手指按住拖动时状态就丢了；而按钮"按下去有没有反应"决定了
 * 用户会不会怀疑自己点偏了——这是移动端最常见的不确定感来源。
 *
 * 做法很小：给元素加 `is-press` 类，120ms 后移除。配合 moss.scss 里
 * 与 `:active` 并列的选择器，视觉上就稳定了。
 *
 * 不用指令/包装组件：那会改变模板结构，而这只是三行 DOM 操作。
 */

const HOLD_MS = 120

interface Pressable {
  classList: { add(c: string): void; remove(c: string): void }
}

export function pressFeedback(el: unknown): void {
  const node = el as Partial<Pressable> | undefined
  const list = node?.classList
  if (list === undefined) return
  list.add('is-press')
  setTimeout(() => {
    list.remove('is-press')
  }, HOLD_MS)
}
