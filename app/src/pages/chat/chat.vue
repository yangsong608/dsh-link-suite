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
import { state, skinClass, themeClass, liteClass } from '@/core/store'
import { haptic } from '@/core/haptic'
import { currentLink, connectDevice, setSessionListener } from '@/core/link'
import MossDot from '@/components/moss/MossDot.vue'

type Item =
  | { k: 'user'; text: string; at: string }
  | { k: 'assist'; text: string; at: string; streaming?: boolean }
  | { k: 'activity'; tool: string; summary: string; ms: string; ok?: boolean; callId?: string }
  | { k: 'approval'; id: string; cmd: string; risk: string; state: 'pending' | 'ok' | 'no'; at: string }

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
  uni.showActionSheet({
    itemList: ['重命名会话', '归档会话', '查看会话信息'],
    success: (res) => {
      if (res.tapIndex === 0) void renameCurrent()
      else if (res.tapIndex === 1) void archiveCurrent()
      else if (res.tapIndex === 2) showInfo()
    },
  })
}

async function renameCurrent(): Promise<void> {
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  uni.showModal({
    title: '重命名会话',
    editable: true,
    content: title.value,
    success: async (res) => {
      if (!res.confirm) return
      const next = String(res.content ?? '').trim()
      if (next.length === 0) return
      try {
        await link.call('session.rename', { sessionId: sessionId.value, title: next })
        title.value = next
        uni.showToast({ title: '已重命名', icon: 'none' })
      } catch (e) {
        uni.showToast({ title: e instanceof Error ? e.message.slice(0, 16) : '失败', icon: 'none' })
      }
    },
  })
}

async function archiveCurrent(): Promise<void> {
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  uni.showModal({
    title: '归档这个会话？',
    content: '归档后不再出现在列表里，日志仍保留在电脑上。',
    confirmText: '归档',
    success: async (res) => {
      if (!res.confirm) return
      try {
        await link.call('session.archive', { sessionId: sessionId.value, force: true })
        uni.showToast({ title: '已归档', icon: 'none' })
        setTimeout(() => uni.navigateBack(), 600)
      } catch (e) {
        uni.showToast({ title: e instanceof Error ? e.message.slice(0, 16) : '失败', icon: 'none' })
      }
    },
  })
}

function showInfo(): void {
  uni.showModal({
    title: '会话信息',
    content: `会话 ID：${sessionId.value}\n状态：${statusLabel.value}\n已加载：${items.value.length} 条`,
    showCancel: false,
    confirmText: '关闭',
  })
}

/** 模型目录（第一次点开时拉取并缓存到本页生命周期内）。 */
const models = ref<{
  provider: string
  name: string
  models: { id: string; name: string; reasoning?: unknown }[]
}[]>([])
const selectedModel = ref<{ provider: string; model: string } | undefined>(undefined)
const queueCount = ref(0)

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
    /**
     * 摊平模型列表。分组用「提供商 · 模型名」避免同名模型混淆
     * （实测目录里多个 provider 都有 fine-tune 版本）。
     */
    const flat: { label: string; provider: string; model: string }[] = []
    for (const g of models.value) {
      for (const m of g.models) {
        const prefix = g.name.length > 0 ? `${g.name} · ` : ''
        flat.push({ label: `${prefix}${m.name}`, provider: g.provider, model: m.id })
      }
    }
    if (flat.length === 0) {
      uni.showToast({ title: '宿主没有可用模型', icon: 'none' })
      return
    }
    uni.showActionSheet({
      itemList: flat.slice(0, 20).map((x) => x.label),
      success: (res) => {
        const pick = flat[res.tapIndex]
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

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (text.length === 0 || sending.value) return
  const link = currentLink()
  if (link === undefined) {
    errorText.value = '尚未连接主机，请先在首页连接或配对'
    return
  }
  if (sessionId.value === '') {
    errorText.value = '还不知道要发到哪个会话（会话列表里点一个进入）'
    return
  }

  haptic('medium')
  sending.value = true
  errorText.value = ''
  items.value.push({ k: 'user', text, at: nowLabel() })
  draft.value = ''
  void scrollToEnd()

  try {
    // requestId 由客户端生成并应持久化：断线重发时宿主靠它去重。
    // 这里用时间戳+随机串，够用且不引依赖。
    const requestId = `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    await link.call('session.prompt', { sessionId: sessionId.value, text, requestId })
  } catch (error) {
    errorText.value = `发送失败：${error instanceof Error ? error.message : String(error)}`
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
    return
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
    } else if (k === 'assist') {
      items.value.push({ k: 'assist', text: String(data['text'] ?? ''), at: nowLabel() })
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
      } else {
        items.value.push({ k: 'activity', tool, summary, ms, ok: ok ?? true })
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
  const device = state.devices.find((d) => d.deviceId === state.activeId) ?? state.devices[0]
  host.value = device?.name ?? ''
  if (device !== undefined) connectDevice(device)

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
  // 页面离开就取消监听，避免回退后旧页面的闭包继续改 items
  setSessionListener(undefined)
})
</script>

<template>
  <view :class="rootClass">
    <view class="veil" />
    <view class="grain" />

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

    <scroll-view class="flow" scroll-y :scroll-top="scrollTop" :scroll-with-animation="true">
      <view class="daystamp mono">2026-10-23</view>

      <template v-for="(it, i) in items" :key="i">
        <!-- 用户：右对齐，唯一有底色的东西 -->
        <view v-if="it.k === 'user'" class="me">
          <text class="me-b">{{ it.text }}</text>
        </view>

        <!-- agent：左竖条，无底色 -->
        <view v-else-if="it.k === 'assist'" class="ai">
          <view class="ai-bar" />
          <view class="ai-body">
            <text class="ai-t">{{ it.text }}</text>
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

    <view class="composer safe-bottom">
      <!-- 模型选择：与 dsh 同步，改变后续回合用的模型 -->
      <view class="modelbar">
        <view class="model" @tap="pickModel">
          <text class="mono">{{ modelLabel }}</text>
          <view class="caret" />
        </view>
        <text v-if="queueCount > 0" class="queue mono t3">{{ queueCount }} 条排队</text>
      </view>

      <view class="field">
        <view class="plus mono" @tap="haptic('light')">+</view>
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
          :class="{ on: draft.length > 0 && !sending, 'is-disabled': draft.length === 0 || sending }"
          @tap="send"
        >
          <view class="ico-up" />
        </view>
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

.send.stop { color: var(--danger); border-color: var(--danger-bd); background: var(--danger-soft); }

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
.send svg { width: 17px; height: 17px; }
</style>
