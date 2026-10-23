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
  | { k: 'activity'; tool: string; summary: string; ms: string; ok?: boolean }
  | { k: 'approval'; id: string; cmd: string; risk: string; state: 'pending' | 'ok' | 'no'; at: string }

const title = ref('会话')
const host = ref('')
const draft = ref('')
const scrollTop = ref(0)
const sessionId = ref('')
const sending = ref(false)
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

  if (method === 'session.stream') {
    const k = data['k']
    if (k === 'assist') {
      items.value.push({ k: 'assist', text: String(data['text'] ?? ''), at: nowLabel() })
    } else if (k === 'activity') {
      const ms = typeof data['ms'] === 'number' ? `${String(data['ms'])}ms` : ''
      items.value.push({
        k: 'activity',
        tool: String(data['tool'] ?? 'tool'),
        summary: String(data['summary'] ?? ''),
        ms,
        ok: data['ok'] === false ? false : true,
      })
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
      <view class="back" @tap="back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </view>
      <view class="top-mid">
        <text class="tt">{{ title }}</text>
        <view class="tsub">
          <MossDot status="online" />
          <text class="mono">{{ host }}</text>
          <text class="t3">· 运行中</text>
        </view>
      </view>
      <view class="more mono t3">···</view>
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
      <view class="field">
        <view class="plus mono" @tap="haptic('light')">+</view>
        <input v-model="draft" class="in" placeholder="发指令…" placeholder-class="ph" @confirm="send" />
        <!-- on 同时表达"有内容"与"没在发送中"：发送中再点会重复发消息 -->
        <view
          class="send"
          :class="{ on: draft.length > 0 && !sending, 'is-disabled': draft.length === 0 || sending }"
          @tap="send"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.top {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 8px;
  border-bottom: 1px solid var(--bd);
  background: linear-gradient(180deg, var(--bg) 60%, transparent);
}

.back { width: 34px; height: 34px; display: grid; place-items: center; color: var(--t2); }
.back svg { width: 20px; height: 20px; }

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

.flow { flex: 1; padding: 0 14px; height: 0; }

.daystamp { text-align: center; font-size: 10px; color: var(--t3); margin: 14px 0; letter-spacing: 1px; }

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
.composer {
  padding: 8px 12px;
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
