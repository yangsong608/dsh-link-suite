<script setup lang="ts">
/**
 * 对话页（核心）。
 *
 * 视觉上刻意不用"气泡"：agent 的输出不加底色，只有左侧 2px 竖条。
 * moss 的终端里没有气泡，只有行——沿用这个，信息密度更高，
 * 而且屏幕窄的时候不会出现"一屏三个气泡什么也没说"。
 */
import { computed, nextTick, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { state, skinClass, themeClass, liteClass } from '@/core/store'
import { haptic } from '@/core/haptic'
import MossDot from '@/components/moss/MossDot.vue'

type Item =
  | { k: 'user'; text: string; at: string }
  | { k: 'assist'; text: string; at: string; streaming?: boolean }
  | { k: 'activity'; tool: string; summary: string; ms: string; ok?: boolean }
  | { k: 'approval'; id: string; cmd: string; risk: string; state: 'pending' | 'ok' | 'no'; at: string }

const title = ref('重构上传通道，加上断点续传')
const host = ref('MacBook Pro')
const draft = ref('')
const scrollTop = ref(0)

const items = ref<Item[]>([
  { k: 'user', text: '上传通道现在是整文件一次性传给宿主，断网就废。加上断点续传。', at: '14:01' },
  {
    k: 'assist',
    text: '先看一下现在的实现，再决定分块大小与重传策略。',
    at: '14:01',
  },
  { k: 'activity', tool: 'Read', summary: 'packages/plugin/src/fs/upload.ts', ms: '42ms', ok: true },
  { k: 'activity', tool: 'Grep', summary: 'CHUNK_BYTES | uploadId | resume', ms: '18ms', ok: true },
  {
    k: 'assist',
    text: '分块已经按 512KiB 做了，但没有 resumable 语义：uploadId 每次重连都重建。我打算把 uploadId 落到磁盘，并在 fs.upload 之前加一次 HEAD 探测，让客户端知道已经收到多少。',
    at: '14:03',
  },
  { k: 'activity', tool: 'Edit', summary: 'upload.ts  ·  +48 −12', ms: '310ms', ok: true },
  {
    k: 'approval',
    id: 'ap_1',
    cmd: '$ npm run build',
    risk: '会覆盖 dist/ 下 3 个产物（+1.2MB），使用你当前用户权限运行',
    state: 'pending',
    at: '14:05',
  },
])

const rootClass = computed(() => ['dsh', skinClass.value, themeClass.value, liteClass.value])
const pendingApproval = computed(() => items.value.find((i) => i.k === 'approval' && i.state === 'pending'))

function back(): void {
  uni.navigateBack()
}

async function scrollToEnd(): Promise<void> {
  await nextTick()
  scrollTop.value = 999999 + Math.random()
}

function approve(item: Extract<Item, { k: 'approval' }>, ok: boolean): void {
  haptic(ok ? 'heavy' : 'heavy')
  item.state = ok ? 'ok' : 'no'
  items.value.push({
    k: 'assist',
    text: ok ? '开始构建…（日志会持续追加）' : '好，停下了。你想换成别的做法吗？',
    at: '14:05',
    streaming: ok,
  })
  void scrollToEnd()
}

function send(): void {
  const text = draft.value.trim()
  if (text.length === 0) return
  haptic('medium')
  items.value.push({ k: 'user', text, at: '现在' })
  draft.value = ''
  void scrollToEnd()
}

onLoad((q) => {
  if (q && typeof q['id'] === 'string') {
    // 真实实现里按 id 拉 session.follow；这里只演示第一条
  }
  state.waiting = 1
  void scrollToEnd()
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
        <view class="send" :class="{ on: draft.length > 0 }" @tap="send">
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
.composer {
  padding: 8px 12px;
  border-top: 1px solid var(--bd);
  background: linear-gradient(0deg, var(--bg) 72%, transparent);
}

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
