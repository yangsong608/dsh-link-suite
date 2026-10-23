<script setup lang="ts">
/**
 * 会话列表（跨设备聚合）。
 *
 * 分组顺序不是"时间倒序"，是**按需要你的程度**：
 * 等待你 → 进行中 → 最近完成。时间倒序会让"三小时前跑完的任务"压住"正在等你批准的"。
 */
import { computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import PageShell from '@/components/PageShell.vue'
import MossDot from '@/components/moss/MossDot.vue'
import MossBadge from '@/components/moss/MossBadge.vue'
import { state, type SessionRow } from '@/core/store'
import { haptic } from '@/core/haptic'
import { connectDevice, refreshAll, currentLink } from '@/core/link'

const rows = computed(() => state.sessions)

/** 有没有会话在跑。空列表时角标不亮——"没东西在跑"本身是有效信息。 */
const anyRunning = computed(() => rows.value.some((r) => r.status === 'running'))
const groups = computed(() => [
  {
    key: 'waiting',
    label: '等待你',
    items: rows.value.filter((r) => r.status === 'waiting-approval' || r.status === 'waiting-input'),
  },
  { key: 'running', label: '进行中', items: rows.value.filter((r) => r.status === 'running') },
  {
    key: 'done',
    label: '最近完成',
    items: rows.value.filter((r) => r.status === 'done' || r.status === 'error' || r.status === 'idle'),
  },
])

/** 时间显示：今天给时刻，昨天给"昨天"，更早给日期。手写而不是引库，省 3KB。 */
function timeOf(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '—'
  const d = new Date(updatedAt)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const yesterday = new Date(now.getTime() - 86_400_000)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  return `${String(d.getMonth() + 1)}/${String(d.getDate())}`
}

function statusLabel(status: SessionRow['status']): string {
  switch (status) {
    case 'waiting-approval':
      return '等待审批'
    case 'waiting-input':
      return '等待回答'
    case 'running':
      return '进行中'
    case 'error':
      return '出错'
    case 'idle':
      return '空闲'
    default:
      return '已完成'
  }
}

/** 刷新：连上主机后拉真实列表；失败时保留旧列表并提示。 */
async function refresh(): Promise<void> {
  const result = await refreshAll()
  if (!result.ok && result.error !== undefined) {
    uni.showToast({ title: result.error.slice(0, 18), icon: 'none' })
  }
}

function openChat(row: SessionRow): void {
  haptic('light')
  uni.navigateTo({ url: `/pages/chat/chat?id=${row.id}` })
}

/**
 * 会话长按菜单：改名 / 归档。
 *
 * 为什么是长按而不是每行一个"..."按钮：
 *   行内按钮会把可点区域挤到 30% 以下，而点开对话是最高频操作。
 *   长按不占位置，也不会误触。
 *
 * 为什么没有"删除"：dsh 只能归档（移出列表、日志保留）。
 * 给用户一个假的删除按钮，会让他以为数据被清掉了——那比没有更糟。
 */
function sessionMenu(row: SessionRow): void {
  haptic('medium')
  uni.showActionSheet({
    itemList: ['重命名', '归档（移出列表，日志保留）'],
    success: (res) => {
      if (res.tapIndex === 0) void renameSession(row)
      else if (res.tapIndex === 1) void archiveSession(row)
    },
  })
}

async function renameSession(row: SessionRow): Promise<void> {
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  // showModal 的 editable 在部分平台不可用，用 showModal 拿输入后校验
  uni.showModal({
    title: '重命名会话',
    editable: true,
    placeholderText: row.title,
    content: row.title,
    success: async (res) => {
      if (!res.confirm) return
      const title = String(res.content ?? '').trim()
      if (title.length === 0) return
      try {
        await link.call('session.rename', { sessionId: row.id, title })
        row.title = title
        uni.showToast({ title: '已重命名', icon: 'none' })
      } catch (error) {
        uni.showToast({ title: error instanceof Error ? error.message.slice(0, 16) : '失败', icon: 'none' })
      }
    },
  })
}

async function archiveSession(row: SessionRow): Promise<void> {
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  const running = row.status === 'running'
  uni.showModal({
    title: '归档会话',
    content: running
      ? '这个会话正在运行。归档会先停止它，日志仍保留。继续？'
      : '归档后它不再出现在列表里，日志仍保留在电脑上。',
    confirmText: '归档',
    success: async (res) => {
      if (!res.confirm) return
      try {
        // 正在运行的会话必须显式 force，否则宿主会拒绝（session-active）
        await link.call('session.archive', { sessionId: row.id, force: running })
        state.sessions = state.sessions.filter((s) => s.id !== row.id)
        uni.showToast({ title: '已归档', icon: 'none' })
      } catch (error) {
        uni.showToast({ title: error instanceof Error ? error.message.slice(0, 16) : '失败', icon: 'none' })
      }
    },
  })
}

onLoad(() => {
  // 进入会话页时确保已连接（首页可能还没连，或连接在切 tab 时丢了）
  const device = state.devices.find((d) => d.deviceId === state.activeId) ?? state.devices[0]
  if (device !== undefined) connectDevice(device)
  void refresh()
})

function goTab(tab: 'devices' | 'sessions' | 'me'): void {
  const map = { devices: '/pages/index/index', sessions: '/pages/sessions/sessions', me: '/pages/me/me' }
  uni.reLaunch({ url: map[tab] })
}
</script>

<template>
  <PageShell active="sessions" @tab="goTab">
    <view class="head safe-top">
      <text class="h1">会话</text>
      <view class="head-r">
        <text class="mono t3">{{ state.devices.length }} 台机器</text>
        <!-- 角标放在标题右侧：一眼知道"有没有东西在跑"，不用逐条看状态 -->
        <MossBadge :size="24" :working="anyRunning" :glow="!state.lite" />
      </view>
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
            :class="{ waiting: r.status === 'waiting-approval' || r.status === 'waiting-input' }"
            @tap="openChat(r)"
            @longpress="sessionMenu(r)"
          >
            <view class="srow-l">
              <MossDot
                :status="
                  r.status === 'running'
                    ? 'connecting'
                    : r.status === 'waiting-approval' || r.status === 'waiting-input'
                      ? 'soft'
                      : r.status === 'error'
                        ? 'offline'
                        : 'online'
                "
              />
              <view class="srow-body">
                <text class="st">{{ r.title }}</text>
                <text class="ex">{{ r.excerpt ?? statusLabel(r.status) }}</text>
              </view>
            </view>
            <view class="srow-r">
              <text class="host mono">{{ statusLabel(r.status) }}</text>
              <text class="tm mono">{{ timeOf(r.updatedAt) }}</text>
            </view>
          </view>
        </template>
      </template>

      <view class="foot t3">会话数据来自各台电脑，本地只留最近 2000 条</view>
    </view>
  </PageShell>
</template>

<style lang="scss" scoped>
.head-r {
  display: flex;
  align-items: center;
  gap: 8px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-right: 16px;
  padding-bottom: 8px;
  padding-left: 16px;
  /* 刻意不用 padding 简写：简写会把 padding-top 重置为 0，
     覆盖掉 .head 上的 .safe-top（状态栏安全区）。 */
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
