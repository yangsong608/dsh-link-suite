<script setup lang="ts">
/**
 * 会话列表（跨设备聚合）。
 *
 * 分组顺序不是"时间倒序"，是**按需要你的程度**：
 * 等待你 → 进行中 → 最近完成。时间倒序会让"三小时前跑完的任务"压住"正在等你批准的"。
 */
import { computed } from 'vue'
import PageShell from '@/components/PageShell.vue'
import MossDot from '@/components/moss/MossDot.vue'
import { state } from '@/core/store'
import { haptic } from '@/core/haptic'

interface SessionRow {
  id: string
  title: string
  host: string
  status: 'waiting' | 'running' | 'done' | 'error'
  excerpt: string
  time: string
}

const demo: SessionRow[] = [
  {
    id: 's_1',
    title: '重构上传通道，加上断点续传',
    host: 'MacBook Pro',
    status: 'waiting',
    excerpt: '需要你确认：会覆盖 dist/ 下 3 个产物（+1.2MB）',
    time: '14:05',
  },
  {
    id: 's_2',
    title: '把 auth 中间件从 cookie 换成 device key',
    host: 'MacBook Pro',
    status: 'running',
    excerpt: '正在读 packages/auth/src/index.ts',
    time: '进行中',
  },
  {
    id: 's_3',
    title: '分析一下这个仓库的构建时长',
    host: 'Studio 工作站',
    status: 'waiting',
    excerpt: 'agent 问：要不要连 CI 的历史数据一起看？',
    time: '13:41',
  },
  {
    id: 's_4',
    title: '生成上周的周报',
    host: 'MacBook Pro',
    status: 'done',
    excerpt: '已生成 docs/weekly-42.md',
    time: '昨天',
  },
]

const rows = computed(() => demo)
const groups = computed(() => [
  { key: 'waiting', label: '等待你', items: rows.value.filter((r) => r.status === 'waiting') },
  { key: 'running', label: '进行中', items: rows.value.filter((r) => r.status === 'running') },
  { key: 'done', label: '最近完成', items: rows.value.filter((r) => r.status === 'done' || r.status === 'error') },
])

function openChat(row: SessionRow): void {
  haptic('light')
  uni.navigateTo({ url: `/pages/chat/chat?id=${row.id}` })
}

function goTab(tab: 'devices' | 'sessions' | 'me'): void {
  const map = { devices: '/pages/index/index', sessions: '/pages/sessions/sessions', me: '/pages/me/me' }
  uni.reLaunch({ url: map[tab] })
}
</script>

<template>
  <PageShell active="sessions" @tab="goTab">
    <view class="head safe-top">
      <text class="h1">会话</text>
      <text class="mono t3">{{ state.devices.length }} 台机器</text>
    </view>

    <view class="scroll">
      <template v-for="g in groups" :key="g.key">
        <template v-if="g.items.length > 0">
          <view class="sect">
            <text>{{ g.label }}</text>
            <text class="mono t3">{{ g.items.length }}</text>
          </view>

          <view
            v-for="r in g.items"
            :key="r.id"
            class="srow"
            :class="{ waiting: r.status === 'waiting' }"
            @tap="openChat(r)"
          >
            <view class="srow-l">
              <MossDot :status="r.status === 'running' ? 'connecting' : r.status === 'waiting' ? 'soft' : r.status === 'done' ? 'online' : 'offline'" />
              <view class="srow-body">
                <text class="st">{{ r.title }}</text>
                <text class="ex">{{ r.excerpt }}</text>
              </view>
            </view>
            <view class="srow-r">
              <text class="host mono">{{ r.host }}</text>
              <text class="tm mono">{{ r.time }}</text>
            </view>
          </view>
        </template>
      </template>

      <view class="foot t3">会话数据来自各台电脑，本地只留最近 2000 条</view>
    </view>
  </PageShell>
</template>

<style lang="scss" scoped>
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 16px 8px;
}

.h1 { font-size: 21px; font-weight: 700; letter-spacing: 0.4px; }

/* 底部安全距离由 moss.scss 的 .scroll 统一给，这里只管左右 */
.scroll { padding-left: 12px; padding-right: 12px; }

.srow {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 12px;
  margin-bottom: 8px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--s1);
}

.srow:active { transform: scale(0.99); background: var(--s2); }

.srow.waiting {
  border-color: rgba(232, 194, 74, 0.4);
  background: linear-gradient(180deg, rgba(232, 194, 74, 0.06), var(--s1));
}

.srow-l { display: flex; gap: 9px; flex: 1; min-width: 0; padding-top: 3px; }
.srow-body { flex: 1; min-width: 0; }

.st {
  display: block;
  font-size: 14px;
  line-height: 19px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ex {
  display: block;
  margin-top: 3px;
  font-size: 11.5px;
  line-height: 16px;
  color: var(--t3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.srow-r {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex: 0 0 auto;
}

.host { font-size: 10px; color: var(--t3); max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tm { font-size: 10px; color: var(--t3); }
.srow.waiting .tm { color: var(--warn); }

.foot { margin: 24px 4px; text-align: center; font-size: 10.5px; opacity: 0.7; }
</style>
