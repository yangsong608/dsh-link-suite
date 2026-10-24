<script setup lang="ts">
/**
 * 对话页（核心）。
 *
 * 视觉上刻意不用"气泡"：agent 的输出不加底色，只有左侧 2px 竖条。
 * moss 的终端里没有气泡，只有行——沿用这个，信息密度更高，
 * 而且屏幕窄的时候不会出现"一屏三个气泡什么也没说"。
 */
import { computed, nextTick, onUnmounted, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { state, skinClass, themeClass, liteClass, type SessionRow } from '@/core/store'
import { haptic } from '@/core/haptic'
import { humanBytes, pickFile, pickImage } from '@/core/attach'
import { currentLink, connectDevice, connectionStatus, disconnect, refreshAll, setSessionListener } from '@/core/link'
import MossDot from '@/components/moss/MossDot.vue'
import MossSheet, { type SheetItem } from '@/components/MossSheet.vue'
import MossMarkdown from '@/components/MossMarkdown.vue'
import MossFileView from '@/components/MossFileView.vue'

type Item =
  | { k: 'user'; text: string; at: string }
  | { k: 'assist'; text: string; at: string; streaming?: boolean }
  | { k: 'activity'; tool: string; summary: string; ms: string; ok?: boolean; callId?: string }
  | { k: 'approval'; id: string; cmd: string; risk: string; state: 'pending' | 'ok' | 'no'; at: string }

/**
 * 三段视图（对应设计文档 08-v2 §3.3，参考 Qoder「看进度 + 验收成果」）。
 *
 *   chat  对话      —— 人话与工具摘要，回答"它在做什么"
 *   trace 执行过程  —— 全量事件（think/tool/text/note），回答"具体做了什么"
 *   files 产物      —— 这一轮改了哪些文件，回答"我能验收什么"
 *
 * 手机上三段是**切换**不是并列：并列会把每一段挤到读不了。
 * 平板横屏时列表与内容并排（见 sessions 页的三栏）。
 */
/** 宽屏（平板横屏/大屏）时启用三栏：会话列表 / 对话 / 产物。 */
const wide = ref(false)

/**
 * 连接状态横幅。
 *
 * 原来断开后只在设备页能看到"离线"，用户停在对话页发消息，
 * 失败提示又跑到聊天流顶部——他只会觉得"发了没反应"。
 */
/* ── 计划步骤与斜杠命令 ───────────────────────────────────────────── */

interface PlanStep { text: string; status: string }
const planSteps = ref<PlanStep[]>([])

/*
 * todo 与提问都来自**工具调用**，不是会话投影。
 *
 * 实测（在 dsh 源码里 grep）：`todo_write` / `ask_user_question` 只出现在
 * experimental/claude-code-mods，没有对应的 sessionProjections 注册。
 * 也就是说宿主的会话投影里没有它们，只能从 tool/call 的 arguments 里读。
 */
interface TodoItem { text: string; status: string }
const todoItems = ref<TodoItem[]>([])
const todoDone = computed(() => todoItems.value.filter((x) => x.status === 'completed').length)
/**
 * 全部完成就不再占地方。
 *
 * 原来只判 length > 0：任务全做完了，那条「任务 5/5」还挂在输入区上方，
 * 既没过期信号也关不掉。清完就该消失。
 */
const todoAllDone = computed(() => todoItems.value.length > 0 && todoDone.value === todoItems.value.length)

interface AskQuestion { id: string; question: string; options: string[] }
interface AskItem { callId: string; questions: AskQuestion[] }
/** 当前显示第几题：与 PC 端一致，一题一题答，不一次糊一屏。 */
const askIndex = ref(0)
const askCard = ref<AskItem | undefined>(undefined)

/** 从 todo_write 的参数里取清单（字段是 todos[].content/status）。 */
function readTodos(args: string): void {
  try {
    const o = JSON.parse(args) as { todos?: { content?: string; status?: string }[] }
    if (!Array.isArray(o.todos)) return
    todoItems.value = o.todos.map((t) => ({ text: String(t.content ?? ''), status: String(t.status ?? 'pending') }))
    // 全部完成时直接收起来，连状态都清掉
    if (todoItems.value.every((t) => t.status === 'completed')) todoItems.value = []
  } catch { /* 参数不是 JSON 就忽略 */ }
}

/** 从 ask_user_question 的参数里取问题与选项。 */
function readAsk(args: string, callId: string): void {
  try {
    const o = JSON.parse(args) as {
      questions?: { id?: string; question?: string; options?: { label?: string }[] }[]
    }
    const list = Array.isArray(o.questions) ? o.questions : []
    if (list.length === 0) return
    askIndex.value = 0
    askCard.value = {
      callId,
      questions: list.map((q, i) => ({
        id: String(q.id ?? `q${i}`),
        question: String(q.question ?? ''),
        options: Array.isArray(q.options) ? q.options.map((x) => String(x.label ?? '')) : [],
      })),
    }
  } catch { /* 忽略 */ }
}

/** 点选项 → 真正回答宿主提问。 */
function answerAsk(questionId: string, label: string): void {
  const link = currentLink()
  const card = askCard.value
  if (link === undefined || card === undefined) return
  haptic('medium')
  void link.call('session.answer', {
    sessionId: sessionId.value,
    callId: card.callId,
    answers: [{ id: questionId, selected: [label] }],
  }).then((r) => {
    const res = r as { ok?: boolean }
    if (res.ok === true) {
      const total = card.questions.length
      if (askIndex.value + 1 < total) {
        askIndex.value += 1
      } else {
        askCard.value = undefined
      }
      uni.showToast({ title: '已回答', icon: 'none' })
    } else {
      uni.showToast({ title: '回答未被接受（可能已过期）', icon: 'none' })
    }
  }).catch((e: unknown) => handleError(e, '回答失败：'))
}
const planActive = ref(false)
const planOpen = ref(false)

/** 读宿主 plan 投影：agent 打算做什么、做到哪了。 */
async function loadPlan(): Promise<void> {
  const link = currentLink()
  if (link === undefined || sessionId.value === '') return
  try {
    const r = await link.call<{ active: boolean; steps: PlanStep[] }>('session.plan', { sessionId: sessionId.value })
    planActive.value = r.active === true
    planSteps.value = Array.isArray(r.steps) ? r.steps : []
  } catch {
    // 宿主没有 plan 投影（未装 plan-mode）就整块不显示
    planSteps.value = []
  }
}

const doneSteps = computed(() => planSteps.value.filter((x) => x.status === 'completed').length)

/**
 * 发送斜杠命令。
 *
 * 必须走 session.command：/plan 这类是宿主命令注册表处理的，
 * 当普通消息发出去只会被当成一句话，不会进入 plan 模式。
 */
async function runCommand(line: string): Promise<void> {
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  haptic('light')
  try {
    const r = await link.call<{ ok: boolean; text: string }>('session.command', {
      sessionId: sessionId.value,
      text: line,
    })
    uni.showToast({ title: r.text.length > 0 ? r.text.slice(0, 22) : '已执行', icon: 'none' })
    void loadPlan()
  } catch (e) {
    handleError(e, '')
  }
}

/**
 * 主机锁屏。
 *
 * 宿主会在空闲（默认 10 分钟）后自动上锁，之后所有 operator 操作都会被
 * 拒绝并返回 lock/locked。App 原来只会把错误显示成"主机已锁定"，
 * 却没有解锁入口——用户被锁在门外却无路可走。
 */
function openUnlock(): void {
  openSheet({
    kind: 'prompt',
    title: '主机已锁定',
    message: '输入电脑上设置的锁屏密码来解锁。任务仍在后台继续运行。',
    placeholder: '锁屏密码',
    confirmText: '解锁',
    onConfirm: (text) => {
      const link = currentLink()
      const password = text.trim()
      if (link === undefined || password.length === 0) return
      void link.call('lock.unlock', { password }).then(() => {
        errorText.value = ''
  askCard.value = undefined
        uni.showToast({ title: '已解锁', icon: 'none' })
        void loadPlan()
      }).catch((e: unknown) => {
        uni.showToast({ title: e instanceof Error ? e.message.slice(0, 20) : '解锁失败', icon: 'none' })
      })
    },
  })
}

/** 统一的错误处理：锁屏错误直接弹解锁，其余贴红条。 */
function handleError(error: unknown, prefix = ''): void {
  const code = (error as { code?: string } | undefined)?.code
  if (code === 'lock/locked' || code === 'lock/bad-password') {
    openUnlock()
    return
  }
  errorText.value = `${prefix}${error instanceof Error ? error.message : String(error)}`
}

const activeDevice = computed(() => state.devices.find((d) => d.deviceId === state.activeId))

/*
 * 用**真实链路状态**，不用 device.conn。
 *
 * device.conn 是界面缓存：refreshAll 会把所有宿主设备标成 online，
 * 别的地方又会改它，切换模型之类的一次刷新就可能让它短暂不等于 online，
 * 于是横幅误报"已断开"。
 *
 * 再加 2 秒防抖：链路状态在 RPC 密集时会有瞬时抖动，
 * 一抖就弹横幅既吵又难点（横幅本身还在动）。
 */
const linkOnline = ref(true)
let offlineTicks = 0
let connTimer: ReturnType<typeof setInterval> | undefined
const linkDown = computed(() => !linkOnline.value)

function tickConn(): void {
  const online = connectionStatus() === 'online'
  if (online) {
    offlineTicks = 0
    linkOnline.value = true
    return
  }
  offlineTicks += 1
  // 连续 2 次（约 2 秒）不恢复才认为真的断了
  if (offlineTicks >= 2) linkOnline.value = false
}

function startConnWatch(): void {
  tickConn()
  connTimer = setInterval(tickConn, 1000)
}

function stopConnWatch(): void {
  if (connTimer !== undefined) { clearInterval(connTimer); connTimer = undefined }
}

function reconnectNow(): void {
  const device = activeDevice.value
  if (device === undefined) return
  haptic('medium')
  // 幂等连接对同地址不重建，先断开再连（与设备页「重新连接」一致）
  disconnect()
  connectDevice(device)
}

/**
 * 长会话的渲染窗口。
 *
 * 一个会话可能有几千条消息，全部渲染会让每次状态更新都重排整棵 DOM
 * （手机上尤其明显：滚动卡、输入延迟）。这里只渲染最近 N 条，
 * 往上翻时再按需放开。内存侧另有硬上限，超出就丢最老的。
 */
const RENDER_STEP = 150
const MEMORY_CAP = 1500
const renderLimit = ref(RENDER_STEP)

const visibleItems = computed(() =>
  items.value.length <= renderLimit.value ? items.value : items.value.slice(-renderLimit.value),
)
const hasMore = computed(() => items.value.length > renderLimit.value)

function loadMore(): void {
  haptic('light')
  renderLimit.value += RENDER_STEP
}

/** 内存上限：只裁内存，不影响用户已看到的内容（窗口会跟着走）。 */
function trimItems(): void {
  if (items.value.length <= MEMORY_CAP) return
  const drop = items.value.length - MEMORY_CAP
  items.value.splice(0, drop)
  renderLimit.value = Math.max(RENDER_STEP, renderLimit.value - drop)
}
/** 右栏是否展开。宽屏下也要能收起——产物面板占 300px，看长代码时很碍事。 */
const rightOpen = ref(true)

/**
 * 两栏宽度（可拖拽）。
 *
 * 平板横屏下左栏 240 / 右栏 300 只是一个起点：会话标题长短、产物路径长短
 * 差别很大，固定值必然有一边不好用。用拖拽让用户自己定，但夹在合理区间内，
 * 避免拖到 0 或占满整屏把中间区域挤没。
 */
const leftW = ref(240)
const rightW = ref(300)
const LEFT_RANGE = [180, 420] as const
const RIGHT_RANGE = [220, 520] as const

let drag: { side: 'left' | 'right'; startX: number; startW: number } | undefined

type DragEvent = { touches?: ArrayLike<{ clientX: number }>; clientX?: number }

function startDrag(side: 'left' | 'right', ev: DragEvent): void {
  const x = ev.touches?.[0]?.clientX ?? ev.clientX ?? 0
  drag = { side, startX: x, startW: side === 'left' ? leftW.value : rightW.value }
  haptic('light')
}

function onDrag(ev: DragEvent): void {
  if (drag === undefined) return
  const x = ev.touches?.[0]?.clientX ?? ev.clientX ?? 0
  const delta = x - drag.startX
  if (drag.side === 'left') {
    leftW.value = clamp(drag.startW + delta, LEFT_RANGE[0], LEFT_RANGE[1])
  } else {
    // 右栏在右边：向右拖 = 变窄
    rightW.value = clamp(drag.startW - delta, RIGHT_RANGE[0], RIGHT_RANGE[1])
  }
}

function endDrag(): void {
  if (drag !== undefined) haptic('light')
  drag = undefined
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/**
 * 左栏按工作区分组。
 *
 * 之前是平铺列表，和会话页的分组逻辑不一致——同一个应用里两处对同一个
 * 概念用两种组织方式，用户会以为左边那个是"最近"、右边那个是"全部"。
 * 归属来源仍是 workspace.sessionIds（dsh 的权威归属）。
 */
interface RailGroup {
  id: string
  name: string
  items: SessionRow[]
}
const railGroups = computed<RailGroup[]>(() => {
  const byId = new Map(state.sessions.map((x) => [x.id, x]))
  const claimed = new Set<string>()
  const out: RailGroup[] = []
  for (const ws of state.workspaces) {
    const items = (ws.sessionIds ?? [])
      .map((id) => byId.get(id))
      .filter((x): x is SessionRow => x !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const it of items) claimed.add(it.id)
    if (items.length === 0) continue
    out.push({ id: ws.id, name: ws.name || ws.path, items })
  }
  const orphans = state.sessions.filter((x) => !claimed.has(x.id))
  if (orphans.length > 0) out.push({ id: '__orphans__', name: '未归类', items: orphans })
  return out
})

function updateWide(): void {
  const before = wide.value
  try {
    const info = uni.getWindowInfo?.() ?? uni.getSystemInfoSync()
    wide.value = Number(info.windowWidth ?? 0) >= 1000
  } catch {
    wide.value = false
  }
  // 刚进入宽屏：右栏是常驻的，需要立刻有产物数据，
  // 否则会停在"这一轮还没有产物"（其实只是没拉过）。
  if (!before && wide.value && sessionId.value !== '') void loadChanges()
}

/*
 * 旋转必须重算，否则"横屏三栏"只在进入页面那一刻成立：
 * 竖屏进入 → 转横屏 → 还是单列（用户会以为没做适配）。
 * uni 的 onWindowResize 在 App 与 H5 都可用；拿不到就退回监听 orientation。
 */
/** 固定引用：offWindowResize 必须传同一个函数才能解绑。 */
const onResize = (): void => { updateWide() }

function bindResize(): void {
  try {
    uni.onWindowResize(onResize)
  } catch {
    // 老版本/不支持的平台：至少监听浏览器 resize
    if (typeof window !== 'undefined') window.addEventListener('resize', onResize)
  }
}

function unbindResize(): void {
  try { uni.offWindowResize(onResize) } catch { /* 平台不支持就算了 */ }
  if (typeof window !== 'undefined') window.removeEventListener('resize', onResize)
}

const tab = ref<'chat' | 'trace' | 'files'>('chat')

/** 执行过程：保留原始 trace 事件，不去重不合并。 */
const traceItems = ref<{ k: string; label: string; detail?: string; at: string }[]>([])
/** 产物：文件变更列表（由 session.changes 填充）。 */
const fileItems = ref<{ path: string; op: string; additions?: number; deletions?: number }[]>([])
/** 产物是近似的：只有文件工具的记录，没有 shell/git。必须告诉用户。 */
const changesNote = ref('')
const diffView = ref<{ path: string; hunks: { t: string; s: string }[] } | undefined>(undefined)

/** 文件查看器（按格式渲染）。tap 看当前内容，长按看本轮差异。 */
const fileOpen = ref(false)
const filePath = ref('')

function openFile(path: string): void {
  haptic('light')
  filePath.value = path
  fileOpen.value = true
}

function browseWorkspace(): void {
  haptic('light')
  filePath.value = ''
  fileOpen.value = true
}

/**
 * 统一弹层控制器。
 *
 * 全应用不再用 uni.showActionSheet / showModal：
 *   - 原生样式与 MOSS 视觉不搭
 *   - showActionSheet 在部分平台最多 6 项，超出**静默丢弃**
 *     （模型列表十几项，点"选模型"没反应就是这个）
 */
interface SheetState {
  visible: boolean
  kind: 'menu' | 'confirm' | 'prompt' | 'info'
  title?: string
  multiline?: boolean
  items?: SheetItem[]
  message?: string
  value?: string
  placeholder?: string
  confirmText?: string
  onSelect?: (index: number) => void
  onConfirm?: (text: string) => void
}
const sheet = ref<SheetState>({ visible: false, kind: 'menu' })

function openSheet(opts: Omit<SheetState, 'visible'>): void {
  sheet.value = { visible: true, ...opts }
}

function onSheetSelect(index: number): void {
  sheet.value.onSelect?.(index)
}

function onSheetConfirm(text: string): void {
  sheet.value.onConfirm?.(text)
}

/** 待发附件。图片内联；文件先上传换成 receiptId。 */
interface PendingAttach {
  kind: 'image' | 'file'
  name: string
  bytes: number
  data?: string
  mediaType?: string
  receiptId?: string
  uploading?: boolean
  error?: string
}
const attaches = ref<PendingAttach[]>([])

const title = ref('会话')
const host = ref('')
const draft = ref('')
const scrollTop = ref(0)
const sessionId = ref('')
const sending = ref(false)
/** 历史是否还在加载。true 时显示骨架屏而不是"空会话"。 */
const loadingHistory = ref(false)
/** 头部状态点：由 snapshot / turn 事件更新 */
const sessionStatus = ref<'idle' | 'running' | 'waiting' | 'done' | 'error'>('idle')
/** 已加载的历史游标，用于向上翻页 */
const oldestSeq = ref<number | undefined>(undefined)
const hasMoreHistory = ref(false)

/** 头部状态点的视觉映射。MossDot 只认这几个值。 */
const dotForStatus = computed(() => {
  switch (sessionStatus.value) {
    case 'running': return 'connecting' as const
    case 'waiting': return 'soft' as const
    case 'error': return 'offline' as const
    case 'done': return 'online' as const
    // MossDot 只接受 online/connecting/offline/needs-auth/locked/soft，
    // 空闲用 'soft'（半亮圆点）而不是自造一个 'idle'
    default: return 'soft' as const
  }
})

const statusLabel = computed(() => {
  switch (sessionStatus.value) {
    case 'running': return '运行中'
    case 'waiting': return '等待批准'
    case 'error': return '出错'
    case 'done': return '已完成'
    default: return '空闲'
  }
})
/** 出错原因。空串表示没有错误——比一个 isError 布尔值好，因为要显示文案。 */
const errorText = ref('')

// 初值是空的：真实数据由 session.follow 推上来。
// 演示数据留在这里最危险——它会让"没连上"看起来像"连上了但没内容"。
const items = ref<Item[]>([])

const rootClass = computed(() => ['dsh', skinClass.value, themeClass.value, liteClass.value])
const pendingApproval = computed(() => items.value.find((i) => i.k === 'approval' && i.state === 'pending'))

function back(): void {
  uni.navigateBack()
}

/**
 * 右上角菜单。
 *
 * 之前这个 ··· 只是装饰，点了没反应——比不显示更糟，
 * 因为它暗示"这里有东西可以点"。
 */
function chatMenu(): void {
  haptic('light')
  openSheet({
    kind: 'menu',
    title: '会话操作',
    items: [
      { label: '重命名会话', hint: '改的是标题，不影响内容' },
      { label: '归档会话', hint: '移出列表，日志仍保留在电脑上' },
      { label: '查看会话信息', hint: '会话 ID / 状态 / 已加载条数' },
    ],
    onSelect: (i) => {
      if (i === 0) void renameCurrent()
      else if (i === 1) void archiveCurrent()
      else if (i === 2) showInfo()
    },
  })
}

async function renameCurrent(): Promise<void> {
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  openSheet({
    kind: 'prompt',
    title: '重命名会话',
    value: title.value,
    placeholder: '会话标题',
    confirmText: '保存',
    onConfirm: (text) => {
      const next = text.trim()
      if (next.length === 0) return
      void link.call('session.rename', { sessionId: sessionId.value, title: next }).then(() => {
        title.value = next
        uni.showToast({ title: '已重命名', icon: 'none' })
      }).catch((e: unknown) => {
        uni.showToast({ title: e instanceof Error ? e.message.slice(0, 16) : '失败', icon: 'none' })
      })
    },
  })
}

async function archiveCurrent(): Promise<void> {
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  openSheet({
    kind: 'confirm',
    title: '归档这个会话',
    message: '归档后不再出现在列表里，日志仍保留在电脑上。',
    confirmText: '归档',
    onConfirm: () => {
      void (async () => {
        try {
          await link.call('session.archive', { sessionId: sessionId.value, force: true })
          uni.showToast({ title: '已归档', icon: 'none' })
          setTimeout(() => uni.navigateBack(), 600)
        } catch (e) {
          uni.showToast({ title: e instanceof Error ? e.message.slice(0, 16) : '失败', icon: 'none' })
        }
      })()
    },
  })
}

function showInfo(): void {
  openSheet({
    kind: 'info',
    title: '会话信息',
    message: `会话 ID：${sessionId.value}\n状态：${statusLabel.value}\n已加载：${items.value.length} 条`,
  })
}

/** 模型目录（第一次点开时拉取并缓存到本页生命周期内）。 */
const models = ref<{
  provider: string
  name: string
  models: { id: string; name: string; reasoning?: unknown }[]
}[]>([])
const selectedModel = ref<{ provider: string; model: string } | undefined>(undefined)
/**
 * 队列（dsh 的 agent inbox）。
 *
 * 两个列表语义不同：
 *   nextTurn = 下一轮开始前依次执行（FIFO，每轮一条）
 *   nextStep = 在下一个 step 边界插进去（steer，立刻影响当前这轮）
 * 用户不需要知道这些名词，但界面要把"排队"和"插话"分开，
 * 否则他会疑惑"我发的消息为什么没生效"。
 */
const queue = ref<{ nextTurn: { itemId: string; text: string }[]; nextStep: { itemId: string; text: string }[] }>({
  nextTurn: [],
  nextStep: [],
})
const queueCount = computed(() => queue.value.nextTurn.length + queue.value.nextStep.length)

const modelLabel = computed(() => {
  const m = selectedModel.value
  if (m === undefined) return '默认模型'
  for (const g of models.value) {
    for (const x of g.models) {
      if (x.id === m.model && (g.provider === m.provider || g.provider === '')) return x.name
    }
  }
  return m.model
})

/** 拉一次队列快照。agent 运行时也要拉——排队项正是这时候才存在。 */
async function loadQueue(): Promise<void> {
  const link = currentLink()
  if (link === undefined || sessionId.value === '') return
  try {
    const out = await link.call<{
      nextTurn: { itemId: string; text: string }[]
      nextStep: { itemId: string; text: string }[]
    }>('session.queue.list', { sessionId: sessionId.value })
    queue.value = { nextTurn: out.nextTurn ?? [], nextStep: out.nextStep ?? [] }
  } catch {
    // 老宿主没有队列接口：不显示队列区，而不是报错
    queue.value = { nextTurn: [], nextStep: [] }
  }
}

async function loadChanges(): Promise<void> {
  const link = currentLink()
  if (link === undefined || sessionId.value === '') return
  try {
    const out = await link.call<{
      files: { path: string; op: string; additions: number; deletions: number }[]
      approximate?: boolean
      note?: string
    }>('session.changes', { sessionId: sessionId.value })
    fileItems.value = out.files ?? []
    changesNote.value = out.approximate === true ? (out.note ?? '') : ''
  } catch {
    fileItems.value = []
  }
}

/** 点开一个文件看差异。手机上用弹层显示，避免再做一层路由。 */
async function openDiff(f: { path: string }): Promise<void> {
  haptic('light')
  const link = currentLink()
  if (link === undefined) return
  try {
    const d = await link.call<{ path: string; additions: number; deletions: number; hunks: { t: string; s: string }[] }>(
      'session.diff', { sessionId: sessionId.value, path: f.path },
    )
    diffView.value = d
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message.slice(0, 18) : '读取失败', icon: 'none' })
  }
}

async function queueRemove(itemId: string): Promise<void> {
  haptic('medium')
  const link = currentLink()
  if (link === undefined) return
  try {
    await link.call('session.queue.remove', { sessionId: sessionId.value, itemId })
    await loadQueue()
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message.slice(0, 18) : '删除失败', icon: 'none' })
  }
}

async function queueSteer(itemId: string): Promise<void> {
  haptic('medium')
  const link = currentLink()
  if (link === undefined) return
  try {
    await link.call('session.queue.steer', { sessionId: sessionId.value, itemId })
    await loadQueue()
    uni.showToast({ title: '已插到当前这轮的下一步', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message.slice(0, 20) : '插话失败', icon: 'none' })
  }
}

async function queueEdit(item: { itemId: string; text: string }): Promise<void> {
  const link = currentLink()
  if (link === undefined) return
  openSheet({
    kind: 'prompt',
    title: '修改排队消息',
    value: item.text,
    multiline: true,
    placeholder: '这条消息会在当前这轮结束后发出',
    confirmText: '保存',
    onConfirm: (text) => {
      const next = text.trim()
      if (next.length === 0) return
      void link.call('session.queue.edit', { sessionId: sessionId.value, itemId: item.itemId, text: next })
        .then(() => loadQueue())
        .catch((e: unknown) => {
          uni.showToast({ title: e instanceof Error ? e.message.slice(0, 18) : '修改失败', icon: 'none' })
        })
    },
  })
}

/**
 * ＋ 按钮：选图 / 选文件。
 *
 * 图片内联（prompt 的 image 块直接带 base64），文件走 fs.upload 换 receiptId。
 * 两者都先进待发列表，用户可以删掉再发——选错了不该被迫发出去。
 */
function pickAttach(): void {
  haptic('light')
  openSheet({
    kind: 'menu',
    title: '添加附件',
    items: [
      { label: '拍照 / 选图片', hint: '图片直接内联发送，不走上传' },
      { label: '选择文件', hint: '先上传换成凭证，再随消息发出' },
    ],
    onSelect: (i) => {
      if (i === 0) void addImage()
      else if (i === 1) void addFile()
    },
  })
}

async function addImage(): Promise<void> {
  try {
    const picked = await pickImage()
    if (picked === undefined) return
    attaches.value.push({
      kind: 'image',
      name: picked.name,
      bytes: picked.bytes,
      data: picked.data,
      mediaType: picked.mediaType,
    })
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message.slice(0, 20) : '选图失败', icon: 'none' })
  }
}

async function addFile(): Promise<void> {
  const link = currentLink()
  if (link === undefined || sessionId.value === '') {
    uni.showToast({ title: '先连接一台电脑', icon: 'none' })
    return
  }
  try {
    const picked = await pickFile()
    if (picked === undefined) return
    const item: PendingAttach = { kind: 'file', name: picked.name, bytes: picked.bytes, uploading: true }
    attaches.value.push(item)
    try {
      // receiptId 只在同一会话的 Agent 作用域内有效，所以必须带 sessionId
      const out = await link.call<{ receiptId: string }>('fs.upload', {
        sessionId: sessionId.value,
        name: picked.name,
        data: picked.data,
      })
      item.receiptId = out.receiptId
    } catch (e) {
      item.error = e instanceof Error ? e.message.slice(0, 24) : '上传失败'
    } finally {
      item.uploading = false
    }
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message.slice(0, 20) : '选文件失败', icon: 'none' })
  }
}

function removeAttach(index: number): void {
  haptic('light')
  attaches.value.splice(index, 1)
}

async function loadCatalog(): Promise<void> {
  if (models.value.length > 0) return
  const link = currentLink()
  if (link === undefined) return
  try {
    const out = await link.call<{
      default: { provider: string; model: string }
      groups: { provider: string; name: string; models: { id: string; name: string; reasoning?: unknown }[] }[]
    }>('session.modelCatalog')
    models.value = out.groups ?? []
    if (out.default?.model) selectedModel.value = { provider: out.default.provider, model: out.default.model }
  } catch {
    // 老宿主没有这个接口：不显示模型栏，而不是报错
    models.value = []
  }
}

function pickModel(): void {
  haptic('light')
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  void loadCatalog().then(() => {
    const flat: { label: string; hint: string; provider: string; model: string }[] = []
    for (const g of models.value) {
      for (const m of g.models) {
        flat.push({
          label: m.name,
          hint: g.name.length > 0 ? g.name : g.provider,
          provider: g.provider,
          model: m.id,
        })
      }
    }
    if (flat.length === 0) {
      uni.showToast({ title: '宿主没有可用模型', icon: 'none' })
      return
    }
    openSheet({
      kind: 'menu',
      title: '选择模型',
      // 不再 slice(0,20)：自定义弹层能滚动，模型多也不会被截掉
      items: flat.map((x) => ({ label: x.label, hint: x.hint })),
      onSelect: (i) => {
        const pick = flat[i]
        if (pick === undefined) return
        void link.call('session.selectModel', {
          sessionId: sessionId.value,
          provider: pick.provider,
          model: pick.model,
        }).then(() => {
          selectedModel.value = { provider: pick.provider, model: pick.model }
          uni.showToast({ title: `已切到 ${pick.label}`, icon: 'none' })
        }).catch((e: unknown) => {
          uni.showToast({ title: e instanceof Error ? e.message.slice(0, 18) : '切换失败', icon: 'none' })
        })
      },
    })
  })
}

/** 中断当前回合。远程场景下没有这个按钮，用户只能干等。 */
async function cancelRun(): Promise<void> {
  haptic('heavy')
  const link = currentLink()
  if (link === undefined) return
  try {
    await link.call('session.cancel', { sessionId: sessionId.value })
    sessionStatus.value = 'idle'
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message.slice(0, 18) : '取消失败', icon: 'none' })
  }
}

/** 变更类型的单字标识：+ 新增 / ~ 修改 / − 删除 / → 改名 */
function opLabel(op: string): string {
  switch (op) {
    case 'add': return '+'
    case 'mod': return '~'
    case 'del': return '−'
    case 'rename': return '→'
    default: return '·'
  }
}

/**
 * 左栏：切会话。
 *
 * 宽屏下不该为了换会话退回列表页——那会把整页状态丢掉。
 * 这里只做"平铺 + 工作区名"的最小实现，不重复列表页的分组交互。
 */
/** 左栏状态文案：给中文，别把协议里的英文枚举直接怼给用户。 */
function statusText(status: string): string {
  switch (status) {
    case 'running': return '进行中'
    case 'waiting-approval': return '待批准'
    case 'waiting-input': return '待回复'
    case 'done': return '已完成'
    case 'error': return '出错'
    default: return '空闲'
  }
}

function switchSession(row: SessionRow): void {
  if (row.id === sessionId.value) return
  haptic('light')
  uni.redirectTo({ url: `/pages/chat/chat?id=${row.id}` })
}

function onTab(next: 'chat' | 'trace' | 'files'): void {
  haptic('light')
  tab.value = next
  if (next === 'files') void loadChanges()
}

async function scrollToEnd(): Promise<void> {
  await nextTick()
  scrollTop.value = 999999 + Math.random()
}

async function approve(item: Extract<Item, { k: 'approval' }>, ok: boolean): Promise<void> {
  haptic('heavy')
  const link = currentLink()
  if (link === undefined) {
    errorText.value = '尚未连接主机'
    return
  }
  // 先乐观置态，失败再回滚：点完之后卡半秒不动是最糟的反馈
  item.state = ok ? 'ok' : 'no'
  try {
    await link.call('approval.answer', { id: item.id, outcome: ok ? 'allowed-once' : 'rejected' })
    void scrollToEnd()
  } catch (error) {
    item.state = 'pending'
    errorText.value = `批准失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 选项式提问的回答：当作一条普通消息发回去。 */
function answerChoice(label: string): void {
  haptic('medium')
  void (async () => {
    const link = currentLink()
    if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
    try {
      await link.call('session.prompt', {
        sessionId: sessionId.value,
        text: label,
        requestId: `r_${Date.now().toString(36)}`,
      })
      uni.showToast({ title: '已回复', icon: 'none' })
    } catch (e) {
      handleError(e, '发送失败：')
    }
  })()
}

async function send(): Promise<void> {
  const text = draft.value.trim()
  // 只发附件也是合法操作（"把这张图给它看"），所以空文字不直接返回
  if ((text.length === 0 && attaches.value.length === 0) || sending.value) return
  const link = currentLink()
  if (link === undefined) {
    errorText.value = '尚未连接主机，请先在首页连接或配对'
    return
  }
  if (sessionId.value === '') {
    errorText.value = '还不知道要发到哪个会话（会话列表里点一个进入）'
    return
  }

  // 附件先定稿：有上传失败的就不让发，避免"以为发了其实丢了一半"
  const failed = attaches.value.find((a) => a.error !== undefined)
  if (failed !== undefined) {
    errorText.value = `「${failed.name}」上传失败，删掉它或重试`
    return
  }
  const sending_attaches = attaches.value.filter((a) => a.uploading !== true)
  const images = sending_attaches
    .filter((a) => a.kind === 'image' && a.data !== undefined)
    .map((a) => ({ mediaType: a.mediaType ?? 'image/png', data: a.data as string }))
  const receipts = sending_attaches
    .filter((a) => a.kind === 'file' && a.receiptId !== undefined)
    .map((a) => a.receiptId as string)

  haptic('medium')
  sending.value = true
  errorText.value = ''
  const attachLabel = sending_attaches.length > 0 ? `（${String(sending_attaches.length)} 个附件）` : ''
  items.value.push({ k: 'user', text: text + attachLabel, at: nowLabel() })
  trimItems()
  draft.value = ''
  attaches.value = []
  void scrollToEnd()

  try {
    // requestId 由客户端生成并应持久化：断线重发时宿主靠它去重。
    // 这里用时间戳+随机串，够用且不引依赖。
    const requestId = `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

    /*
     * 运行中就走队列，不要硬塞给当前这轮。
     *
     * 用户此刻发的多半是"顺便再改一下"，硬 steer 会打断 agent 正在做的事；
     * 排到下一轮则不会干扰，而且界面上能看到它确实排上了。
     * 空闲时直接发（等价于开新的一轮）。
     */
    if (sessionStatus.value === 'running') {
      await link.call('session.queue.push', { sessionId: sessionId.value, text, requestId, attachments: receipts })
      await loadQueue()
      uni.showToast({ title: '已加入队列，当前这轮结束后执行', icon: 'none' })
      return
    }

    await link.call('session.prompt', {
      sessionId: sessionId.value,
      text,
      requestId,
      ...(receipts.length === 0 ? {} : { attachments: receipts }),
      ...(images.length === 0 ? {} : { images }),
    })
  } catch (error) {
    handleError(error, '发送失败：')
  } finally {
    sending.value = false
  }
}

function nowLabel(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 把服务端推来的帧接到 UI 上。事件分两路：stream（聊天气泡）与 trace（工具活动）。 */
function onSessionEvent(method: string, payload: unknown): void {
  const data = payload as Record<string, unknown> | undefined
  if (data === undefined) return

  // 历史回放结束：宿主告诉我们已经推了多少条、还有没有更早的
  if (method === 'session.history.end') {
    loadingHistory.value = false
    hasMoreHistory.value = data['hasMore'] === true
    if (typeof data['cursor'] === 'number') oldestSeq.value = data['cursor']
    if (data['error'] === true) errorText.value = '历史加载失败，下拉重试'
    // 历史为空且没有新消息 → 明确告诉用户这是新会话
    if (items.value.length === 0) sessionStatus.value = 'idle'
    void loadPlan()
    return
  }

  // 执行过程：原样收进 traceItems，供"执行过程"页展示
  if (method === 'session.trace') {
    const kind = String(data['k'] ?? '')
    const label =
      kind === 'tool' ? String(data['tool'] ?? 'tool')
        : kind === 'think' ? '思考'
          : kind === 'text' ? '回复'
            : kind === 'note' ? String(data['text'] ?? '轮次')
              : kind === 'approval' ? '审批'
                : kind
    // todo / 提问都靠 arguments 识别，必须在 trace 这一路解析
    if (kind === 'tool') {
      const name = String(data['tool'] ?? '')
      const args = String(data['input'] ?? '')
      const phase = String(data['phase'] ?? '')
      if (name === 'todo_write') readTodos(args)
      if (name === 'ask_user_question') {
        // 结果回来（或新一轮开始）说明这个提问已经不需要展示
        if (phase === 'result') askCard.value = undefined
        else readAsk(args, String(data['callId'] ?? ''))
      }
    }
    const detail =
      kind === 'tool' ? String(data['target'] ?? '')
        : kind === 'think' ? String(data['summary'] ?? '')
          : kind === 'text' ? String(data['text'] ?? '').slice(0, 120)
            : ''
    traceItems.value.push({ k: kind, label, ...(detail.length > 0 ? { detail } : {}), at: nowLabel() })
  }

  // 执行过程中的轮次边界即状态转换
  if (method === 'session.trace') {
    const kind = data['k']
    if (kind === 'approval') sessionStatus.value = 'waiting'
    else if (kind === 'tool' || kind === 'text') sessionStatus.value = 'running'
    else if (kind === 'note' && data['text'] === '本轮结束') sessionStatus.value = 'done'
    else if (kind === 'note' && data['text'] === '本轮失败') sessionStatus.value = 'error'
    return
  }

  if (method === 'session.stream') {
    const k = data['k']
    // history=true 的帧是回放，不需要每来一条就滚动
    const isHistory = data['history'] === true
    // 用户自己发的消息。历史回放会推 k='user'，之前没有这个分支，
    // 于是回看历史时"我说的话"全部消失，只剩 agent 的回复。
    if (k === 'user') {
      items.value.push({ k: 'user', text: String(data['text'] ?? ''), at: nowLabel() })
        trimItems()
    } else if (k === 'assist') {
      items.value.push({ k: 'assist', text: String(data['text'] ?? ''), at: nowLabel() })
        trimItems()
    } else if (k === 'activity') {
      /**
       * 工具调用与结果合并成一行。
       *
       * 宿主对同一次工具会推两帧（tool/call 与 tool/result），都带 callId。
       * 之前每帧各插一行，于是一次调用显示成两行，长会话里滚成"无数个 tool"。
       * 现在按 callId 原地更新：
       *   - 见到 call：插一行"进行中"
       *   - 见到同 callId 的 result：更新那一行（补耗时与成功状态）
       */
      const phase = data['phase'] === 'result' ? 'result' : data['phase'] === 'call' ? 'call' : undefined
      const ms = typeof data['ms'] === 'number' ? `${String(data['ms'])}ms` : ''
      const tool = String(data['tool'] ?? 'tool')
      const summary = String(data['summary'] ?? '')
      const ok = data['ok'] === false ? false : data['ok'] === true ? true : undefined

      /**
       * 合并规则（dsh 的 result 事件不带 callId，只能按 phase 判）：
       *   phase === 'result' → 更新**最后一条** activity，不新增
       *   其它               → 新增一行
       *
       * 这是"一次调用显示两行"的修复。之前 call 和 result 各插一行，
       * 一条会话里几十次工具调用就滚成一片 "▸ tool"。
       */
      const last = items.value.length > 0 ? items.value[items.value.length - 1] : undefined

      if (phase === 'result' && last !== undefined && last.k === 'activity') {
        if (summary.length > 0) last.summary = summary
        if (ms.length > 0) last.ms = ms
        if (ok !== undefined) last.ok = ok
        // 结果里若带有更准确的工具名，补上
        if (tool.length > 0 && last.tool !== tool) last.tool = tool
      } else if (phase === 'result') {
        // 没有可合并的上一行（例如滚动到历史中段才断线重连）：仍然显示，但标为结果
        items.value.push({ k: 'activity', tool, summary, ms, ok: ok ?? true })
        trimItems()
      } else {
        items.value.push({ k: 'activity', tool, summary, ms, ok: ok ?? true })
        trimItems()
      }
    } else if (k === 'approval') {
      items.value.push({
        k: 'approval',
        id: String(data['id'] ?? ''),
        cmd: String(data['cmd'] ?? '需要审批'),
        risk: typeof data['risk'] === 'string' ? data['risk'] : '',
        state: 'pending',
        at: nowLabel(),
      })
      haptic('heavy')
    } else if (k === 'done') {
      // 轮次结束：把最后一条 assist 的 streaming 收掉
    }
    void scrollToEnd()
    return
  }

  if (method === 'approval.request') {
    items.value.push({
      k: 'approval',
      id: String(data['id'] ?? ''),
      cmd: String(data['tool'] ?? '需要审批'),
      risk: typeof data['reason'] === 'string' ? data['reason'] : '',
      state: 'pending',
      at: nowLabel(),
    })
    haptic('heavy')
    void scrollToEnd()
  }
}

onLoad((q) => {
  updateWide()
  bindResize()
  startConnWatch()
  const device = state.devices.find((d) => d.deviceId === state.activeId) ?? state.devices[0]
  host.value = device?.name ?? ''
  if (device !== undefined) connectDevice(device)

  // 宽屏左栏需要会话列表；顺手刷新一次（幂等，代价很小）
  if (wide.value) void refreshAll()

  const id = q !== undefined && typeof q['id'] === 'string' ? q['id'] : ''
  sessionId.value = id

  const row = state.sessions.find((s) => s.id === id)
  title.value = row?.title ?? '会话'

  // 订阅必须先注册再发 follow：否则宿主的头几帧会在监听器就位前丢掉
  setSessionListener(onSessionEvent)
  // 订阅时宿主会立刻回放历史，期间显示骨架屏
  loadingHistory.value = id !== ''

  // 进页面就拉模型目录：否则模型栏永远显示"默认模型"，
  // 用户不知道当前用的是哪个模型。
  void loadCatalog()
  void loadQueue()
  // 宽屏右栏是常驻的，所以进页面就要有产物数据（窄屏等切到 tab 再拉）
  if (wide.value) void loadChanges()

  const link = currentLink()
  if (link !== undefined && id !== '') {
    void link
      .call('session.follow', { sessionId: id })
      .catch((error: unknown) => {
        errorText.value = `订阅失败：${error instanceof Error ? error.message : String(error)}`
      })
  } else if (id === '') {
    errorText.value = '没有指定会话'
  }
})

// 用 Vue 的 onUnmounted 而不是 uni 的 onUnload：后者在当前版本的类型入口里
// 没有导出（运行时有，但 vue-tsc 会红）。行为等价，且这里本来就只关心组件销毁。
onUnmounted(() => {
  unbindResize()
  stopConnWatch()
  // 页面离开就取消监听，避免回退后旧页面的闭包继续改 items
  setSessionListener(undefined)
})
</script>

<template>
  <view :class="[rootClass, { wide }]">
    <view class="veil" />
    <view class="grain" />

    <!-- 宽屏三栏：左＝会话列表，中＝当前对话，右＝产物 -->
    <view
      v-if="wide"
      class="rail-left"
      :style="{ width: leftW + 'px' }"
    >
      <view class="rail-head">
        <text class="rail-title">会话</text>
        <text class="mono t3">{{ state.sessions.length }}</text>
      </view>
      <!-- 拖拽把手：宽 14px 的热区，压在边框上（视觉只有 1px 线） -->
      <view
        class="rail-grip grip-right"
        @touchstart="startDrag('left', $event)"
        @touchmove="onDrag($event)"
        @touchend="endDrag"
        @mousedown="startDrag('left', $event)"
        @mousemove="onDrag($event)"
        @mouseup="endDrag"
      />
      <scroll-view class="rail-scroll" scroll-y>
        <template v-for="g in railGroups" :key="g.id">
          <view class="rail-group">{{ g.name }}</view>
          <view
            v-for="r in g.items"
            :key="r.id"
            class="rail-item"
            :class="{ on: r.id === sessionId }"
            @tap="switchSession(r)"
          >
            <view class="rail-dot" :class="r.status" />
            <view class="rail-body">
              <text class="rail-name">{{ r.title }}</text>
              <text class="rail-meta t3">{{ statusText(r.status) }}</text>
            </view>
          </view>
        </template>
      </scroll-view>
    </view>

    <view class="chat-main">
    <view class="top safe-top">
      <!-- 返回箭头用 CSS 画：uni-app 的 App 端对内联 SVG 支持不稳定，
           之前这里渲染成一片空白（用户看到"左上角有一块空白"）。 -->
      <view class="back" @tap="back" hover-class="back-hover">
        <view class="chev" />
      </view>
      <view class="top-mid">
        <text class="tt">{{ title }}</text>
        <view class="tsub">
          <!-- 状态点跟随真实状态，不再写死「运行中」——那是演示数据留下的假文案 -->
          <MossDot :status="dotForStatus" />
          <text class="mono">{{ host }}</text>
          <text class="t3">· {{ statusLabel }}</text>
        </view>
      </view>
      <view class="more mono t3" @tap="chatMenu">···</view>
    </view>

    <!-- 分段控件：三段视图切换。手上有"看进度/验收"两种意图，混在一页会互相干扰 -->
    <view class="segs">
      <view
        v-for="sg in ([['chat','对话'],['trace','执行过程'],['files','产物']] as const)"
        :key="sg[0]"
        class="seg"
        :class="{ on: tab === sg[0] }"
        @tap="onTab(sg[0])"
      >
        <text>{{ sg[1] }}</text>
        <text v-if="sg[0] === 'files' && fileItems.length > 0" class="seg-n mono">{{ fileItems.length }}</text>
      </view>
    </view>

    <scroll-view v-if="tab === 'chat'" class="flow" scroll-y :scroll-top="scrollTop" :scroll-with-animation="true">
      <view class="daystamp mono">2026-10-23</view>

      <view v-if="hasMore" class="more-row" @tap="loadMore">
        <text class="more-t">载入更早的消息（还有 {{ items.length - renderLimit }} 条）</text>
      </view>
      <template v-for="(it, i) in visibleItems" :key="i">
        <!-- 用户：右对齐，唯一有底色的东西 -->
        <view v-if="it.k === 'user'" class="me">
          <view class="me-b"><MossMarkdown :text="it.text" /></view>
        </view>

        <!-- agent：左竖条，无底色 -->
        <view v-else-if="it.k === 'assist'" class="ai">
          <view class="ai-bar" />
          <view class="ai-body">
            <MossMarkdown class="ai-t" :text="it.text" @answer="answerChoice" />
            <text v-if="it.streaming" class="cursor" />
            <text class="ai-at mono">{{ it.at }}</text>
          </view>
        </view>

        <!-- 活动行：一行摘要，点开才看全部 -->
        <view v-else-if="it.k === 'activity'" class="act">
          <text class="act-tool mono">▸ {{ it.tool }}</text>
          <text class="act-sum mono t3">{{ it.summary }}</text>
          <text class="act-ms mono">{{ it.ms }}</text>
        </view>

        <!-- 审批卡：就地决策，不跳页面 -->
        <view v-else class="term ap" :class="{ done: it.state !== 'pending' }">
          <view class="term-bar">
            <view class="dot" :class="it.state === 'pending' ? 'glow' : ''" style="background: var(--warn)" />
            <text class="name">需要你批准</text>
            <text class="tag mono">{{ it.at }}</text>
          </view>
          <view class="ap-body">
            <text class="ap-cmd mono">{{ it.cmd }}</text>
            <view class="ap-risk">
              <text class="mono t2">{{ it.risk }}</text>
            </view>

            <view v-if="it.state === 'pending'" class="ap-row">
              <view class="btn ghost" @tap="approve(it, false)">拒绝</view>
              <view class="btn primary" @tap="approve(it, true)">批准</view>
            </view>
            <view v-else class="ap-done" :class="it.state">
              <text class="mono">{{ it.state === 'ok' ? '已批准 · 正在执行' : '已拒绝 · 已停止' }}</text>
            </view>
          </view>
        </view>
      </template>

      <view class="tail" />
    </scroll-view>

    <!-- 执行过程：全量事件流。这里不做合并——用户来这一页就是想看细节 -->
    <scroll-view v-else-if="tab === 'trace'" class="flow" scroll-y>
      <view v-if="traceItems.length === 0" class="empty-block">
        <text class="empty-t">还没有执行过程</text>
        <text class="empty-d t3">agent 开始工作后，这里会按时间顺序列出每一步。</text>
      </view>
      <view v-for="(t, i) in traceItems" :key="i" class="trace-row">
        <text class="trace-k mono">{{ t.label }}</text>
        <text v-if="t.detail" class="trace-d">{{ t.detail }}</text>
        <text class="trace-t mono">{{ t.at }}</text>
      </view>
      <view class="tail" />
    </scroll-view>

    <!-- 产物：这一轮改了哪些文件 -->
    <scroll-view v-else class="flow" scroll-y>
      <view v-if="fileItems.length === 0" class="empty-block">
        <text class="empty-t">这一轮还没有产物</text>
        <text class="empty-d t3">agent 写入或修改文件后会出现在这里。</text>
      </view>
      <view class="browse-row" @tap="browseWorkspace">
        <text class="browse-t">浏览工作区文件</text>
        <view class="chev" />
      </view>
      <view v-if="fileItems.length > 0 && changesNote.length > 0" class="changes-note t3">
        {{ changesNote }}
      </view>
      <view v-for="(f, i) in fileItems" :key="i" class="file-row" @tap="openFile(f.path)" @longpress="openDiff(f)">
        <view class="file-op" :class="f.op">{{ opLabel(f.op) }}</view>
        <text class="file-p mono">{{ f.path }}</text>
        <text v-if="f.additions !== undefined" class="file-n mono">
          +{{ f.additions }}<text v-if="f.deletions"> −{{ f.deletions }}</text>
        </text>
      </view>
      <view class="tail" />
    </scroll-view>

    <!-- 队列坞：只在有排队消息时出现。分「待发」与「插话」两类，
         让用户明白自己那条消息什么时候会生效 -->
    <view v-if="queueCount > 0" class="queue-dock">
      <view class="queue-head">
        <text class="queue-title">队列 {{ queueCount }} 条</text>
        <text class="queue-hint t3">当前这轮结束后依次执行</text>
      </view>
      <view v-for="q in queue.nextTurn" :key="q.itemId" class="queue-row">
        <text class="queue-text">{{ q.text }}</text>
        <view class="queue-acts">
          <text class="qact" @tap="queueSteer(q.itemId)">插话</text>
          <text class="qact" @tap="queueEdit(q)">改</text>
          <text class="qact danger" @tap="queueRemove(q.itemId)">删</text>
        </view>
      </view>
      <view v-for="q in queue.nextStep" :key="q.itemId" class="queue-row stepping">
        <text class="queue-tag mono">下一步</text>
        <text class="queue-text">{{ q.text }}</text>
        <view class="queue-acts">
          <text class="qact" @tap="queueEdit(q)">改</text>
          <text class="qact danger" @tap="queueRemove(q.itemId)">删</text>
        </view>
      </view>
    </view>

    <!-- 计划步骤：agent 打算做什么 -->
    <view v-if="planSteps.length > 0" class="plan-bar" @tap="planOpen = !planOpen">
      <view class="plan-head">
        <text class="plan-t">计划 {{ doneSteps }}/{{ planSteps.length }}</text>
        <text v-if="planActive" class="plan-mode mono">PLAN</text>
        <view class="plan-chev" :class="{ open: planOpen }" />
      </view>
      <view v-if="planOpen" class="plan-list">
        <view v-for="(st, i) in planSteps" :key="i" class="plan-item" :class="st.status">
          <text class="plan-dot" />
          <text class="plan-text">{{ st.text }}</text>
        </view>
      </view>
    </view>

    <!-- todo：来自 todo_write 工具调用 -->
    <view v-if="todoItems.length > 0 && !todoAllDone && planSteps.length === 0" class="plan-bar">
      <view class="plan-head">
        <text class="plan-t">任务 {{ todoDone }}/{{ todoItems.length }}</text>
        <view class="plan-chev" :class="{ open: planOpen }" @tap="planOpen = !planOpen" />
      </view>
      <view v-if="planOpen" class="plan-list">
        <view v-for="(t, i) in todoItems" :key="i" class="plan-item" :class="t.status">
          <text class="plan-dot" />
          <text class="plan-text">{{ t.text }}</text>
        </view>
      </view>
    </view>

    <!-- 提问：工具调用里的选项。手机端只能看，回答要在电脑上 -->
    <view v-if="askCard" class="ask-bar">
      <view class="ask-head">
        <text class="ask-q">{{ askCard.questions[askIndex]?.question }}</text>
        <text class="ask-x" @tap="askCard = undefined">×</text>
      </view>
      <text v-if="askCard.questions.length > 1" class="ask-progress mono">
        {{ askIndex + 1 }} / {{ askCard.questions.length }}
      </text>
      <view class="ask-opts">
        <view
          v-for="(o, i) in (askCard.questions[askIndex]?.options ?? [])"
          :key="i"
          class="ask-opt"
          @tap="answerAsk(askCard.questions[askIndex]?.id ?? '', o)"
        >
          <text>{{ o }}</text>
        </view>
      </view>
    </view>

    <!-- 快捷指令：走宿主的命令注册表 -->
    <scroll-view class="cmd-row" scroll-x>
      <view class="cmd" @tap="runCommand('/plan')">
        <text>计划</text>
      </view>
      <view class="cmd" @tap="runCommand('/plan off')">
        <text>退出计划</text>
      </view>
      <view class="cmd" @tap="runCommand('/compact')">
        <text>压缩上下文</text>
      </view>
      <view class="cmd" @tap="runCommand('/goal')">
        <text>目标</text>
      </view>
    </scroll-view>

    <!-- 断线横幅：一直在，直到连上 -->
    <view v-if="linkDown" class="conn-bar" @tap="reconnectNow">
      <text class="conn-t">已断开连接 · 点此重连</text>
      <view class="conn-chev" />
    </view>

    <!-- 发送失败：贴在输入框上方，别让用户找不到 -->
    <view v-if="errorText.length > 0" class="send-bar">
      <text class="send-t">{{ errorText }}</text>
    </view>

    <view class="composer safe-bottom">
      <!-- 模型选择：与 dsh 同步，改变后续回合用的模型 -->
      <view class="modelbar">
        <view class="model" @tap="pickModel">
          <text class="mono">{{ modelLabel }}</text>
          <view class="caret" />
        </view>
        <text v-if="queueCount > 0" class="queue mono t3">{{ queueCount }} 条排队</text>
      </view>

      <!-- 待发附件：选错了可以删掉再发，不该被迫发出去 -->
      <view v-if="attaches.length > 0" class="attach-row">
        <view v-for="(a, i) in attaches" :key="i" class="attach-chip" :class="{ bad: a.error !== undefined }">
          <text class="attach-kind mono">{{ a.kind === 'image' ? 'IMG' : 'FILE' }}</text>
          <text class="attach-name">{{ a.name }}</text>
          <text class="attach-size mono">{{ a.uploading ? '上传中' : a.error ?? humanBytes(a.bytes) }}</text>
          <text class="attach-x" @tap="removeAttach(i)">×</text>
        </view>
      </view>

      <view class="field">
        <view class="plus mono" @tap="pickAttach">+</view>
        <input v-model="draft" class="in" placeholder="发指令…" placeholder-class="ph" @confirm="send" />
        <!--
          运行中显示"停止"，空闲显示"发送"。
          dsh 的 session.cancel 用来中断；不提供停止按钮时，
          用户只能等 agent 自己跑完——远程场景下这非常难受。
          图标改用 CSS 画：App 端内联 SVG 常不渲染（返回箭头踩过）。
        -->
        <view
          v-if="sessionStatus === 'running'"
          class="send stop on"
          @tap="cancelRun"
        >
          <view class="ico-stop" />
        </view>
        <view
          v-else
          class="send"
          :class="{
            on: (draft.length > 0 || attaches.length > 0) && !sending,
            'is-disabled': (draft.length === 0 && attaches.length === 0) || sending,
          }"
          @tap="send"
        >
          <view class="ico-up" />
        </view>
      </view>
    </view>
    </view>

    <!-- 宽屏右栏：产物常驻，可收起 -->
    <view
      v-if="wide"
      class="rail-right"
      :class="{ closed: !rightOpen }"
      :style="{ width: rightOpen ? rightW + 'px' : '40px' }"
    >
      <view class="rail-head">
        <view class="rail-head-l">
          <text class="rail-title">产物</text>
          <text class="mono t3">{{ fileItems.length }}</text>
        </view>
        <view class="rail-toggle" @tap="rightOpen = !rightOpen">
          <view class="chev-r" :class="{ open: rightOpen }" />
        </view>
      </view>
      <view
        v-if="rightOpen"
        class="rail-grip grip-left"
        @touchstart="startDrag('right', $event)"
        @touchmove="onDrag($event)"
        @touchend="endDrag"
        @mousedown="startDrag('right', $event)"
        @mousemove="onDrag($event)"
        @mouseup="endDrag"
      />
      <view v-if="!rightOpen" class="rail-collapsed" @tap="rightOpen = true">产物</view>
      <scroll-view v-if="rightOpen" class="rail-scroll" scroll-y>
        <view v-if="fileItems.length === 0" class="rail-empty t3">这一轮还没有产物</view>
        <view v-for="(f, i) in fileItems" :key="i" class="file-row" @tap="openFile(f.path)" @longpress="openDiff(f)">
          <view class="file-op" :class="f.op">{{ opLabel(f.op) }}</view>
          <text class="file-p mono">{{ f.path }}</text>
        </view>
      </scroll-view>
    </view>

    <MossFileView
      :visible="fileOpen"
      :session-id="sessionId"
      :path="filePath"
      @update:visible="fileOpen = $event"
    />

    <!-- 统一弹层：菜单 / 确认 / 输入 -->
    <MossSheet
      :visible="sheet.visible"
      :kind="sheet.kind"
      :title="sheet.title"
      :items="sheet.items ?? []"
      :message="sheet.message ?? ''"
      :value="sheet.value ?? ''"
      :placeholder="sheet.placeholder ?? ''"
      :confirm-text="sheet.confirmText ?? '确定'"
      @update:visible="sheet.visible = $event"
      @select="onSheetSelect"
      @confirm="onSheetConfirm"
    />

    <!-- 差异弹层：手机上一页只放一个文件，底部抽屉式 -->
    <view v-if="diffView !== undefined" class="diff-mask" @tap="diffView = undefined">
      <view class="diff-panel" @tap.stop>
        <view class="diff-head">
          <text class="diff-path mono">{{ diffView.path }}</text>
          <text class="diff-close" @tap="diffView = undefined">关闭</text>
        </view>
        <scroll-view class="diff-body" scroll-y>
          <view v-for="(l, i) in diffView.hunks" :key="i" class="diff-line" :class="l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''">
            <text class="diff-sig mono">{{ l.t }}</text>
            <text class="diff-txt mono">{{ l.s }}</text>
          </view>
        </scroll-view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
/*
 * 平板上三段（顶栏 / 消息流 / 输入区）都限宽居中。
 * 只限消息流会出现"顶栏铺满、消息缩在中间"的割裂感。
 */
.top {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: var(--content-max, none);
  margin: 0 auto;
  padding: 0 var(--gutter, 12px) 8px;
  border-bottom: 1px solid var(--bd);
  background: linear-gradient(180deg, var(--bg) 60%, transparent);
}

.back {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  flex: none;
}

.back-hover { opacity: 0.6; }

/* 左箭头：8×8 的方块，只留左边与下边，旋转 45° */
.chev {
  width: 9px;
  height: 9px;
  border-left: 2px solid var(--t2);
  border-bottom: 2px solid var(--t2);
  transform: rotate(45deg);
  margin-left: 4px;
}

.top-mid { flex: 1; min-width: 0; }
.tt {
  display: block;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tsub { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 10.5px; color: var(--t3); }

.flow {
  flex: 1;
  height: 0;
  width: 100%;
  max-width: var(--content-max, none);
  margin: 0 auto;
  padding: 0 var(--gutter, 14px);
  box-sizing: border-box;
}

/*
 * 竖屏也要有确定高度，否则整页会跟着滚：头部与输入框被滚走，
 * 用户看到的"只有内容该滚动"就变成了"整页滚动"。
 * 根固定 100dvh + 中间 flow 内部滚动 = 头尾钉住。
 */
.dsh {
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/*
 * 三栏（≥1000px）：
 *   左 240 会话列表 | 中 flex 对话 | 右 300 产物
 * 窄屏时 .wide 不生效，chat-main 独占整屏，布局与原来一致。
 */
/*
 * 注意：不要给这些列写 height:100%。
 *
 * 根容器（.dsh）只有 min-height，没有确定的高度 —— 百分比高度会解析成
 * auto，于是旋转到横屏后三列都只有内容那么高，下半屏空着。
 * 正确做法是让根容器在宽屏时拥有确定高度，列靠 flex 的默认 stretch 撑满。
 */
.chat-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dsh.wide {
  flex-direction: row;
  height: 100vh;   /* 老 WebView 兜底 */
  height: 100dvh;  /* 跟随视口（旋转后立即生效） */
}

.rail-left,
.rail-right {
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--s1);
}

.rail-left { position: relative; border-right: 1px solid var(--bd); }
.rail-right { position: relative; border-left: 1px solid var(--bd); }

/* 拖拽热区：两侧各压住边缘，够宽好按，但视觉上只有那条 1px 边 */
.rail-grip {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 14px;
  z-index: 5;
  cursor: col-resize;
}
.grip-right { right: -7px; }
.grip-left { left: -7px; }

/* 按住时给一条高亮线，明确"正在拖这里" */
.rail-grip:active { background: var(--acc-soft); }

/* 收起后只留一条窄带：看长代码时不该被 300px 面板挡着 */
.rail-right.closed { width: 40px; }

.rail-head-l { display: flex; align-items: baseline; gap: 6px; }

.rail-toggle {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  flex: none;
}

.rail-toggle:active { background: var(--s2); }

/* 折叠箭头：CSS 画的 < > */
.chev-r {
  width: 7px;
  height: 7px;
  border-right: 1.7px solid var(--t2);
  border-bottom: 1.7px solid var(--t2);
  transform: rotate(-45deg);
  margin-left: 2px;
  transition: transform var(--t-fast) var(--ease-out);
}
.chev-r.open { transform: rotate(135deg); margin-left: -2px; }

.rail-collapsed {
  writing-mode: vertical-rl;
  padding: 10px 0;
  font-size: 11.5px;
  color: var(--t3);
  letter-spacing: 3px;
  text-align: center;
}

.rail-group {
  padding: 10px 8px 4px;
  font-size: 10.5px;
  letter-spacing: 0.6px;
  color: var(--t3);
  text-transform: none;
}

.rail-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 14px 12px 8px;
  border-bottom: 1px solid var(--bd);
}

.rail-title { font-size: 12.5px; color: var(--t2); font-weight: 600; letter-spacing: 0.4px; }
.rail-scroll { flex: 1; height: 0; padding: 4px 8px; }
.rail-empty { padding: 20px 8px; font-size: 11.5px; line-height: 17px; }

.rail-item {
  display: flex;
  gap: 8px;
  padding: 9px 8px;
  border-radius: 8px;
  align-items: flex-start;
}

.rail-item:active { background: var(--s2); }
.rail-item.on { background: var(--acc-soft); }

.rail-dot {
  width: 7px; height: 7px; border-radius: 50%;
  margin-top: 5px; flex: none;
  background: var(--t3);
}
.rail-dot.running { background: var(--acc); box-shadow: 0 0 6px var(--acc-glow); }
.rail-dot.waiting-approval, .rail-dot.waiting-input { background: var(--warn); }
.rail-dot.error { background: var(--danger); }

.rail-body { min-width: 0; }
.rail-name { display: block; font-size: 12.5px; color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-meta { font-size: 10px; }

.segs {
  display: flex;
  gap: 4px;
  width: 100%;
  max-width: var(--content-max, none);
  margin: 0 auto;
  padding: 8px var(--gutter, 12px) 6px;
  box-sizing: border-box;
}

.seg {
  flex: 1;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border-radius: 8px;
  color: var(--t3);
  font-size: 12.5px;
  transition: color var(--t-fast) var(--ease-out), background var(--t-fast) var(--ease-out);
}

/* 选中用底色 + 主色文字：纯文字变色在嘈杂背景上不够明确 */
.seg.on {
  color: var(--acc);
  background: var(--acc-soft);
  font-weight: 600;
}

.seg-n {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 6px;
  background: var(--acc);
  color: var(--acc-ink);
}

.empty-block { padding: 40px 8px; text-align: center; }
.empty-t { display: block; font-size: 14px; color: var(--t1); }
.empty-d { display: block; margin-top: 8px; font-size: 11.5px; line-height: 17px; }

.trace-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--bd);
}

.trace-k {
  flex: none;
  min-width: 64px;
  font-size: 11.5px;
  color: var(--acc);
}

.trace-d {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--t2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-t { flex: none; font-size: 10px; color: var(--t3); }

.file-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 0;
  border-bottom: 1px solid var(--bd);
}

.file-op {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  font-size: 10px;
  line-height: 20px;
  text-align: center;
  font-weight: 700;
}

.file-op.add { background: var(--acc-soft); color: var(--acc); }
.file-op.mod { background: var(--warn-soft); color: var(--warn); }
.file-op.del { background: var(--danger-soft); color: var(--danger); }

.file-p { flex: 1; min-width: 0; font-size: 12px; color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-n { flex: none; font-size: 11px; color: var(--t3); }

.daystamp { text-align: center; font-size: 10px; color: var(--t3); margin: 14px 0; letter-spacing: 1px; }

/* 正文用可读字号：手机上 14，平板上 15（见 tokens.scss --fs-body） */
.ai-b, .me-b { font-size: var(--fs-body, 14px); line-height: 1.62; }

/* 用户消息 */
.me { display: flex; justify-content: flex-end; margin: 10px 0; }
.me-b {
  max-width: 84%;
  padding: 9px 12px;
  border-radius: 12px 12px 3px 12px;
  background: var(--acc-soft);
  border: 1px solid var(--bd);
  font-size: 14.5px;
  line-height: 21px;
}

/* agent 输出 */
.ai { display: flex; gap: 9px; margin: 12px 0; }
.ai-bar {
  width: 2px;
  flex: 0 0 2px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--acc), transparent);
  opacity: 0.55;
}
.ai-body { flex: 1; min-width: 0; }
.ai-t { font-size: 14.5px; line-height: 22px; color: var(--t1); }
.ai-at { display: block; margin-top: 5px; font-size: 10px; color: var(--t3); }

/* 活动行 */
.act {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 5px 0 5px 11px;
  margin: 2px 0;
  font-size: 11.5px;
}
.act-tool { color: var(--acc); flex: 0 0 auto; }
.act-sum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.act-ms { font-size: 10px; color: var(--t3); flex: 0 0 auto; }

/* 审批卡 */
.ap { margin: 14px 0; }
.ap-body { padding: 12px 14px 14px; }
.ap-cmd { display: block; font-size: 13px; color: var(--t1); }
.ap-risk { margin: 8px 0 12px; font-size: 11.5px; line-height: 17px; }
.ap-row { display: flex; gap: 9px; }
.ap-row .btn { height: 40px; font-size: 13.5px; }
.ap-done {
  padding: 9px 12px;
  border-radius: var(--r-sm);
  font-size: 12px;
  border: 1px solid var(--bd);
}
.ap-done.ok { color: var(--ok); border-color: var(--bd-strong); }
.ap-done.no { color: var(--t2); }
.ap.done { opacity: 0.9; }

.tail { height: 18px; }

/* 输入区 */
/**
 * 输入区。
 *
 * 底部安全区由 .safe-bottom 统一给（它读 --safe-bottom-real），
 * 这里只补左右与内距。输入框高度 44px：低于这个值点不到，
 * 高于这个值在 6.7 英寸屏上会挤掉一屏消息。
 */
.modelbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px 6px;
}

.model {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--bd);
  background: var(--s1);
}

.model text { font-size: 11px; color: var(--t2); }

/* 小三角：App 端不依赖 SVG */
.caret {
  width: 0;
  height: 0;
  border-left: 3px solid transparent;
  border-right: 3px solid transparent;
  border-top: 4px solid var(--t3);
}

.queue { font-size: 10.5px; }

/* 发送箭头：CSS 画的向上箭头 */
.ico-up {
  width: 10px;
  height: 10px;
  border-left: 2px solid currentColor;
  border-top: 2px solid currentColor;
  transform: rotate(45deg);
  margin-top: 3px;
}

/* 停止方块 */
.ico-stop {
  width: 9px;
  height: 9px;
  border-radius: 1.5px;
  background: currentColor;
}



.attach-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 0 8px;
}

.attach-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--bd);
  background: var(--s1);
}

/* 上传失败时描红：失败项不允许发送，必须让用户看见 */
.attach-chip.bad { border-color: var(--danger-bd); background: var(--danger-soft); }

.attach-kind {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--acc-soft);
  color: var(--acc);
}

.attach-name {
  font-size: 11.5px;
  color: var(--t1);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attach-size { font-size: 10px; color: var(--t3); }
.attach-x { font-size: 14px; color: var(--t3); padding: 0 2px; }

.queue-dock {
  width: 100%;
  max-width: var(--content-max, none);
  margin: 0 auto;
  padding: 8px var(--gutter, 12px);
  box-sizing: border-box;
  border-top: 1px solid var(--bd);
  background: var(--s1);
}

.queue-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.queue-title { font-size: 12px; color: var(--acc); font-weight: 600; }
.queue-hint { font-size: 10.5px; }

.queue-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--bd);
}

.queue-row.stepping { opacity: 0.85; }

.queue-tag {
  flex: none;
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--acc-soft);
  color: var(--acc);
}

.queue-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--t2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-acts { flex: none; display: flex; gap: 10px; }
.qact { font-size: 11.5px; color: var(--acc); }
.qact.danger { color: var(--danger); }

.more-row {
  margin: 12px 0;
  padding: 9px 12px;
  text-align: center;
  border-radius: 8px;
  border: 1px dashed var(--bd);
}

.more-t { font-size: 11.5px; color: var(--t3); }

.browse-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 12px;
  margin-bottom: 8px;
  border-radius: 10px;
  border: 1px dashed var(--bd);
}

.browse-row:active { background: var(--s2); }
.browse-t { font-size: 12.5px; color: var(--acc); }

.chev {
  width: 6px;
  height: 6px;
  border-right: 1.5px solid var(--acc);
  border-top: 1.5px solid var(--acc);
  transform: rotate(45deg);
}

.changes-note {
  padding: 8px 0 4px;
  font-size: 10.5px;
  line-height: 16px;
}

.diff-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: flex-end;
}

.diff-panel {
  width: 100%;
  max-height: 72%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-top-left-radius: var(--r-lg);
  border-top-right-radius: var(--r-lg);
  border-top: 1px solid var(--bd);
}

.diff-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--bd);
}

.diff-path { flex: 1; min-width: 0; font-size: 12px; color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-close { flex: none; font-size: 12.5px; color: var(--acc); }

.diff-body { flex: 1; padding: 8px 12px 16px; }

.diff-line { display: flex; gap: 8px; padding: 1px 0; }
.diff-sig { flex: none; width: 10px; font-size: 11px; color: var(--t3); }
.diff-txt { flex: 1; min-width: 0; font-size: 11.5px; color: var(--t2); white-space: pre-wrap; word-break: break-all; }
.diff-line.add .diff-sig, .diff-line.add .diff-txt { color: var(--acc); }
.diff-line.del .diff-sig, .diff-line.del .diff-txt { color: var(--danger); }

.ask-bar {
  padding: 10px 14px;
  border-top: 1px solid var(--bd);
  background: var(--s1);
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ask-head { display: flex; align-items: flex-start; gap: 10px; }
.ask-x { flex: none; width: 24px; height: 24px; text-align: center; line-height: 22px; font-size: 17px; color: var(--t3); }
.ask-q { flex: 1; font-size: 12.5px; line-height: 19px; color: var(--t1); }
.ask-opt {
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--bd);
  background: var(--s2);
}
.ask-opt text { font-size: 12px; color: var(--t2); }
.ask-opt:active { background: var(--acc-soft); }
.ask-opts { display: flex; flex-direction: column; gap: 7px; }
.ask-q-block { display: flex; flex-direction: column; gap: 6px; }
.ask-sub { font-size: 12px; color: var(--t1); }
.ask-progress { font-size: 10px; color: var(--t3); }
.ask-hint { font-size: 10.5px; color: var(--t3); }
.ask-hint { font-size: 10.5px; color: var(--t3); }

.plan-bar {
  padding: 8px 14px;
  border-top: 1px solid var(--bd);
  background: var(--s1);
}

.plan-head { display: flex; align-items: center; gap: 8px; }
.plan-t { font-size: 11.5px; color: var(--t2); }
.plan-mode { font-size: 9px; padding: 1px 5px; border-radius: 4px; background: var(--acc-soft); color: var(--acc); }

.plan-chev {
  margin-left: auto;
  width: 6px; height: 6px;
  border-right: 1.5px solid var(--t3);
  border-top: 1.5px solid var(--t3);
  transform: rotate(135deg);
}
.plan-chev.open { transform: rotate(-45deg); }

.plan-list { margin-top: 6px; }
.plan-item { display: flex; gap: 7px; padding: 3px 0; }
.plan-dot { flex: none; width: 5px; height: 5px; margin-top: 7px; border-radius: 3px; background: var(--t3); }
.plan-item.completed .plan-dot { background: var(--acc); }
.plan-item.in_progress .plan-dot { background: var(--warn, #e6b43c); }
.plan-text { font-size: 11.5px; line-height: 17px; color: var(--t2); }
.plan-item.completed .plan-text { color: var(--t3); text-decoration: line-through; }

.cmd-row { white-space: nowrap; padding: 6px 12px; border-top: 1px solid var(--bd); }
.cmd {
  display: inline-block;
  margin-right: 8px;
  padding: 5px 12px;
  border-radius: 14px;
  border: 1px solid var(--bd);
  background: var(--s1);
}
.cmd text { font-size: 11.5px; color: var(--t2); }
.cmd:active { background: var(--s2); }

.conn-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  /* 够高的点击区：横幅本身要能一按就中 */
  min-height: 44px;
  padding: 12px 14px;
  position: relative;
  z-index: 6;
  background: var(--warn-soft, rgba(230, 180, 60, 0.14));
  border-top: 1px solid var(--bd);
}

.conn-t { font-size: 12px; color: var(--warn, #e6b43c); }

.conn-chev {
  flex: none;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid var(--warn, #e6b43c);
  border-top: 1.5px solid var(--warn, #e6b43c);
  transform: rotate(45deg);
}

/* 发送失败常驻到下次发送成功：贴在输入框正上方，视线必经处 */
.send-bar {
  padding: 8px 14px;
  background: var(--danger-soft, rgba(229, 72, 77, 0.14));
  border-top: 1px solid var(--bd);
}

.send-t { font-size: 12px; color: var(--danger); line-height: 17px; }

.composer {
  width: 100%;
  max-width: var(--content-max, none);
  margin: 0 auto;
  padding: 8px var(--gutter, 12px);
  border-top: 1px solid var(--bd);
  background: linear-gradient(0deg, var(--bg) 72%, transparent);
}

.field { min-height: 44px; }

/* 发送按钮是唯一的主操作，禁用态必须明显 */
.send.is-disabled { opacity: 0.38; }

.field {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 44px;
  padding: 0 6px 0 10px;
  border-radius: 22px;
  border: 1px solid var(--bd);
  background: var(--s2);
}

.field:focus-within { border-color: var(--bd-strong); }

.plus {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--bd);
  color: var(--t2);
  font-size: 14px;
}

.in { flex: 1; font-size: 14.5px; color: var(--t1); background: transparent; }
.ph { color: var(--t3); }

.send {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--s3);
  color: var(--t3);
  transition: background var(--t-fast), color var(--t-fast);
}

.send.on { background: var(--acc); color: var(--acc-ink); }

/*
 * 停止按钮：必须是红的。
 * 之前写成 `.send.stop.on`，但 `.on` 在后面且同权重，绿色把它盖住了——
 * 结果"停止"看起来和"发送"一模一样，用户根本认不出这是中断操作。
 * 这里提高权重并放到最后，确保红底压过绿色。
 */
.send.stop,
.send.stop.on {
  background: var(--danger);
  color: #1a0806;
  border-color: var(--danger);
  box-shadow: 0 0 10px rgba(255, 92, 77, 0.35);
}
</style>
