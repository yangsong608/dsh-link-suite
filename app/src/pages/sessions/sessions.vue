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
import MossSheet, { type SheetItem } from '@/components/MossSheet.vue'
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

/**
 * 搜索。
 *
 * 过滤发生在**分组之前**：按标题与工作区名做不区分大小写的子串匹配，
 * 命中的会话再走原来的"按工作区分组 + 组内按紧迫度"逻辑。
 * 这样搜索结果仍然保留上下文（哪个项目的），比平铺列表好找。
 *
 * 搜索时不折叠：折叠状态会让命中项藏在收起的组里，
 * 用户会以为"搜不到"。
 */
/** 统一弹层控制器。 */
interface SheetState {
  visible: boolean
  kind: 'menu' | 'confirm' | 'prompt' | 'info'
  title?: string
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

function onSheetSelect(index: number): void { sheet.value.onSelect?.(index) }
function onSheetConfirm(text: string): void { sheet.value.onConfirm?.(text) }

const searching = ref(false)
const keyword = ref('')

function toggleSearch(): void {
  haptic('light')
  searching.value = !searching.value
  if (!searching.value) keyword.value = ''
}

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
  const kw = keyword.value.trim().toLowerCase()
  const match = (title: string | undefined): boolean =>
    kw.length === 0 || String(title ?? '').toLowerCase().includes(kw)

  const wsNameOf = (workspaceId: string): string =>
    state.workspaces.find((w) => w.id === workspaceId)?.name ?? ''

  const byId = new Map(
    state.sessions
      // 命中标题，或命中它所属工作区的名字（"ajl 项目里那个会话"也是常见问法）
      .filter((s) => match(s.title) || match(wsNameOf(s.workspaceId)))
      .map((s) => [s.id, s]),
  )
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
      // 搜索时强制展开：命中项藏在折叠组里等于搜不到
      collapsed: kw.length === 0 && collapsedIds.value.has(ws.id),
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
      collapsed: kw.length === 0 && collapsedIds.value.has('__orphans__'),
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
/**
 * 新建会话。
 *
 * dsh 的 session.create 要一个落点：workspaceId（归属某个工作区）
 * 或 cwd（自己占一个目录）。手机上让用户选工作区最自然——
 * 目录选择在手机上很难用，而且他本来就是在某个项目里干活。
 */
async function newSession(): Promise<void> {
  haptic('light')
  const link = currentLink()
  if (link === undefined) {
    uni.showToast({ title: '先连接一台电脑', icon: 'none' })
    return
  }
  if (state.workspaces.length === 0) {
    uni.showToast({ title: '这台电脑还没有工作区，请先在 DSH 里打开一个项目', icon: 'none' })
    return
  }

  const pick = (index: number): void => {
    const ws = state.workspaces[index]
    if (ws === undefined) return
    void createIn(ws.id)
  }

  // 只有一个工作区就不必让用户再点一次
  if (state.workspaces.length === 1) {
    pick(0)
    return
  }
  openSheet({
    kind: 'menu',
    title: '在哪个工作区新建',
    items: state.workspaces.slice(0, 20).map((w) => ({
      label: w.name || w.path,
      hint: w.path,
    })),
    onSelect: (i) => { pick(i) },
  })
}

async function createIn(workspaceId: string): Promise<void> {
  const link = currentLink()
  if (link === undefined) return
  uni.showLoading({ title: '创建中', mask: true })
  try {
    const out = await link.call<{ sessionId: string }>('session.create', { workspaceId })
    await refresh()
    uni.hideLoading()
    haptic('medium')
    // 直接进对话页：新建完就该开始说话，而不是停在列表
    uni.navigateTo({ url: `/pages/chat/chat?id=${out.sessionId}` })
  } catch (e) {
    uni.hideLoading()
    uni.showToast({ title: e instanceof Error ? e.message.slice(0, 20) : '创建失败', icon: 'none' })
  }
}

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
  openSheet({
    kind: 'menu',
    title: row.title,
    items: [
      { label: '重命名', hint: '只改标题，不影响内容' },
      { label: '归档', hint: '移出列表，日志仍保留在电脑上' },
    ],
    onSelect: (i) => {
      if (i === 0) void renameSession(row)
      else if (i === 1) void archiveSession(row)
    },
  })
}

async function renameSession(row: SessionRow): Promise<void> {
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  openSheet({
    kind: 'prompt',
    title: '重命名会话',
    value: row.title,
    placeholder: '会话标题',
    confirmText: '保存',
    onConfirm: (text) => {
      const title = text.trim()
      if (title.length === 0) return
      void link.call('session.rename', { sessionId: row.id, title }).then(() => {
        row.title = title
        uni.showToast({ title: '已重命名', icon: 'none' })
      }).catch((e: unknown) => {
        uni.showToast({ title: e instanceof Error ? e.message.slice(0, 16) : '失败', icon: 'none' })
      })
    },
  })
}

async function archiveSession(row: SessionRow): Promise<void> {
  const link = currentLink()
  if (link === undefined) { uni.showToast({ title: '尚未连接主机', icon: 'none' }); return }
  const running = row.status === 'running'
  openSheet({
    kind: 'confirm',
    title: '归档会话',
    message: running
      ? '这个会话正在运行。归档会先停止它，日志仍保留在电脑上。'
      : '归档后它不再出现在列表里，日志仍保留在电脑上。',
    confirmText: '归档',
    onConfirm: () => {
      void (async () => {
        try {
          await link.call('session.archive', { sessionId: row.id, force: running })
          state.sessions = state.sessions.filter((x) => x.id !== row.id)
          uni.showToast({ title: '已归档', icon: 'none' })
        } catch (e) {
          uni.showToast({ title: e instanceof Error ? e.message.slice(0, 16) : '失败', icon: 'none' })
        }
      })()
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
        <text v-if="!searching" class="mono t3">{{ state.devices.length }} 台机器</text>
        <view class="search-btn" @tap="toggleSearch">
          <view class="ico-search" :class="{ on: searching }" />
        </view>
        <view class="search-btn" @tap="newSession">
          <view class="ico-plus" />
        </view>
        <!-- 角标放在标题右侧：一眼知道"有没有东西在跑"，不用逐条看状态 -->
        <MossBadge :size="24" :working="anyRunning" :glow="!state.lite" />
      </view>
    </view>

    <!-- 搜索框：只在点了放大镜后出现，平时不占高度 -->
    <view v-if="searching" class="search-row">
      <input
        v-model="keyword"
        class="search-in"
        type="text"
        placeholder="搜索会话标题或工作区"
        placeholder-class="ph"
        :focus="searching"
        confirm-type="search"
      />
      <text v-if="keyword.length > 0" class="search-clear" @tap="keyword = ''">清除</text>
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
      <view v-if="groups.length === 0 && keyword.length > 0" class="empty">
        <text class="empty-t">没有匹配「{{ keyword }}」的会话</text>
        <text class="empty-d t3">试试更短的关键词，或清空搜索。</text>
      </view>
      <view v-else-if="groups.length === 0" class="empty">
        <text class="empty-t">这台电脑还没有会话</text>
        <text class="empty-d t3">在这里新建一个，或者去电脑上开始一个对话。</text>
        <view class="empty-btn" @tap="newSession">
          <text>新建会话</text>
        </view>
      </view>

      <view class="foot t3">会话数据来自各台电脑，本地只留最近 2000 条</view>
    </view>
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

.search-btn {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  flex: none;
}

.search-btn:active { background: var(--s2); }

/* 放大镜：圆 + 柄，纯 CSS */
.ico-search {
  position: relative;
  width: 15px;
  height: 15px;
  border: 1.8px solid var(--t2);
  border-radius: 50%;
}
.ico-search.on { border-color: var(--acc); }
.ico-search.on::after { background: var(--acc); }

.ico-search::after {
  content: '';
  position: absolute;
  right: -4px;
  bottom: -3px;
  width: 6px;
  height: 1.8px;
  background: var(--t2);
  transform: rotate(45deg);
  border-radius: 1px;
}

/* 加号：两条线交叉 */
.ico-plus {
  position: relative;
  width: 15px;
  height: 15px;
}
.ico-plus::before,
.ico-plus::after {
  content: '';
  position: absolute;
  background: var(--acc);
  border-radius: 1px;
}
.ico-plus::before { left: 6.5px; top: 1px; width: 2px; height: 13px; }
.ico-plus::after { top: 6.5px; left: 1px; height: 2px; width: 13px; }

.empty-btn {
  margin: 14px auto 0;
  padding: 9px 18px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd-strong);
  background: var(--acc-soft);
  color: var(--acc);
  font-size: 13px;
  display: inline-block;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 var(--gutter, 16px) 8px;
}

.search-in {
  flex: 1;
  height: 38px;
  padding: 0 12px;
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--s1);
  color: var(--t1);
  font-size: 13.5px;
}

.search-clear { font-size: 12.5px; color: var(--acc); flex: none; }

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

/*
 * 底部说明要留出 tabbar 的高度。
 *
 * 只给容器加 padding-bottom 没用——padding 在 footer 之后，
 * 容器变高了但 footer 的位置没动，仍然被 tabbar 的渐变盖住半行。
 * 必须让 footer 自己有下外边距，把它顶到渐变带上方。
 */
.foot { margin: 24px 4px 64px; text-align: center; font-size: 10.5px; opacity: 0.7; }
</style>
