<script setup lang="ts">
/**
 * 会话列表（跨设备聚合）。
 *
 * 分组顺序不是"时间倒序"，是**按需要你的程度**：
 * 等待你 → 进行中 → 最近完成。时间倒序会让"三小时前跑完的任务"压住"正在等你批准的"。
 */
import { computed, ref } from 'vue'
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
/**
 * 按工作区分组（设计文档 08-v2 §2.1，对应 WorkBuddy 的"任务按文件夹分组"）。
 *
 * 之前是平铺的"等待你 / 进行中 / 最近完成"三组——那是**按状态**分，
 * 用户看着会乱：不同项目的会话混在一起，而他脑子里想的是"那个报表项目"。
 *
 * 现在的结构是两层：
 *   工作区（可折叠）
 *     └ 组内仍按紧迫度分：等待你 → 进行中 → 最近
 *
 * 归属来源：workspace.list 返回的 sessionIds（dsh 的权威归属）。
 * 不在任何 workspace 里的会话放进「未归类」——不能默默丢掉。
 */
interface GroupedSection {
  key: 'waiting' | 'running' | 'recent'
  label: string
  items: SessionRow[]
}

interface WorkspaceGroup {
  id: string
  name: string
  sections: GroupedSection[]
  total: number
  /** 组内有等待项：标题行左侧显示竖条 */
  hasWaiting: boolean
  collapsed: boolean
}

const collapsedIds = ref<Set<string>>(new Set())

function loadCollapsed(): void {
  try {
    const raw = uni.getStorageSync('dsh-link/collapsed')
    if (typeof raw === 'string' && raw.length > 0) {
      collapsedIds.value = new Set(JSON.parse(raw) as string[])
    }
  } catch { /* 读不出来就全部展开 */ }
}

function toggleGroup(id: string): void {
  haptic('light')
  const next = new Set(collapsedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedIds.value = next
  try {
    uni.setStorageSync('dsh-link/collapsed', JSON.stringify([...next]))
  } catch { /* 存不下不影响当前会话 */ }
}

function sectionOf(items: SessionRow[]): GroupedSection[] {
  const waiting = items.filter((r) => r.status === 'waiting-approval' || r.status === 'waiting-input')
  const running = items.filter((r) => r.status === 'running')
  const recent = items.filter((r) => r.status !== 'waiting-approval' && r.status !== 'waiting-input' && r.status !== 'running')
  const out: GroupedSection[] = []
  if (waiting.length > 0) out.push({ key: 'waiting', label: '等待你', items: waiting })
  if (running.length > 0) out.push({ key: 'running', label: '进行中', items: running })
  if (recent.length > 0) out.push({ key: 'recent', label: '最近', items: recent })
  return out
}

const groups = computed<WorkspaceGroup[]>(() => {
  const byId = new Map(state.sessions.map((s) => [s.id, s]))
  const claimed = new Set<string>()
  const out: WorkspaceGroup[] = []

  for (const ws of state.workspaces) {
    const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
    const items = ids
      .map((id) => byId.get(id))
      .filter((x): x is SessionRow => x !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const it of items) claimed.add(it.id)

    const sections = sectionOf(items)
    if (items.length === 0 && state.workspaces.length > 1) continue // 空工作区不占位置
    out.push({
      id: ws.id,
      name: ws.name || ws.path,
      sections,
      total: items.length,
      hasWaiting: sections.some((x) => x.key === 'waiting'),
      collapsed: collapsedIds.value.has(ws.id),
    })
  }

  // 没有 workspace 归属的会话（例如 workspace.list 尚未实现的老宿主）
  const orphans = state.sessions.filter((s) => !claimed.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt)
  if (orphans.length > 0) {
    const sections = sectionOf(orphans)
    out.push({
      id: '__orphans__',
      name: state.workspaces.length === 0 ? '会话' : '未归类',
      sections,
      total: orphans.length,
      hasWaiting: sections.some((x) => x.key === 'waiting'),
      collapsed: collapsedIds.value.has('__orphans__'),
    })
  }

  // 有等待项的组排前面
  return out.sort((a, b) => Number(b.hasWaiting) - Number(a.hasWaiting))
})

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
  loadCollapsed()
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
      <!-- 工作区分组：一层工作区（可折叠），二层紧迫度 -->
      <template v-for="g in groups" :key="g.id">
        <view
          class="ws-head"
          :class="{ 'has-waiting': g.hasWaiting }"
          @tap="toggleGroup(g.id)"
        >
          <text class="ws-arrow mono">{{ g.collapsed ? '▸' : '▾' }}</text>
          <text class="ws-name">{{ g.name }}</text>
          <text class="mono t3">{{ g.total }}</text>
        </view>

        <template v-if="!g.collapsed">
          <template v-for="sec in g.sections" :key="`${g.id}-${sec.key}`">
            <view class="sect">
              <text>{{ sec.label }}</text>
              <text class="mono t3">{{ sec.items.length }}</text>
            </view>

            <view class="sess-grid">
            <view
              v-for="r in sec.items"
              :key="r.id"
              class="srow"
              :class="{ waiting: sec.key === 'waiting' }"
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
                  <!-- 摘要有就显示；没有就不占行——右侧已经有状态了，
                       再写一遍"已完成"是重复信息，反而更难扫 -->
                  <text v-if="r.excerpt" class="ex">{{ r.excerpt }}</text>
                </view>
              </view>
              <view class="srow-r">
                <text class="host mono">{{ statusLabel(r.status) }}</text>
                <text class="tm mono">{{ timeOf(r.updatedAt) }}</text>
              </view>
            </view>
            </view>
          </template>
        </template>
      </template>

      <!-- 真的没有任何会话时给空态，而不是一片空白 -->
      <view v-if="groups.length === 0" class="empty">
        <text class="empty-t">这台电脑还没有会话</text>
        <text class="empty-d t3">在电脑上打开 DSH 开始一个对话，它会出现在这里。</text>
      </view>

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

.ws-head {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 4px;
  margin: 10px 0 2px;
}

.ws-head:active { background: var(--s2); border-radius: 6px; }

/* 有等待项的工作区：左侧竖条，扫一眼就知道该进哪个 */
.ws-head.has-waiting { border-left: 2px solid var(--warn); padding-left: 8px; }

.ws-arrow { font-size: 11px; color: var(--t3); width: 10px; }
.ws-name { font-size: 13px; font-weight: 600; color: var(--t1); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.empty {
  margin: 24px 4px;
  padding: 24px 16px;
  border-radius: var(--r-md);
  border: 1px dashed var(--bd);
  text-align: center;
}

.empty-t { display: block; font-size: 14px; color: var(--t1); }
.empty-d { display: block; margin-top: 8px; font-size: 11.5px; line-height: 17px; }

.sess-grid {
  display: grid;
  grid-template-columns: repeat(var(--grid-sessions, 1), minmax(0, 1fr));
  gap: 8px;
}

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
