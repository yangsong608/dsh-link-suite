<script setup lang="ts">
/**
 * 文件查看器：按格式渲染会话里的文件与产物。
 *
 * 为什么不用系统「打开方式」：手机上根本没有可用的本地应用去开 workspace 里
 * 的 .ts / .md，而且我们要的是"就地看一眼"而不是编辑。
 *
 * 渲染策略（按扩展名与探测结果）：
 *   image      → 直接显示（宿主返回 data URI）
 *   markdown   → MossMarkdown
 *   text/code  → 等宽 + 行号 + 横向滚动
 *   binary     → 明确说明不支持，不假装能看
 *
 * 传输上限在宿主侧（2MB / 20 万字符），这里只负责"超了要说清楚"。
 */
import { computed, ref, watch } from 'vue'
import { currentLink } from '@/core/link'
import { haptic } from '@/core/haptic'
import { humanBytes } from '@/core/attach'
import MossMarkdown from '@/components/MossMarkdown.vue'

type ReadResult =
  | { path: string; kind: 'image'; mime: string; dataUri: string; size: number }
  | { path: string; kind: 'markdown' | 'text'; text: string; truncated?: boolean; size: number }
  | { path: string; kind: 'binary' | 'too-large'; size: number }

interface DirItem { name: string; dir: boolean }

const props = withDefaults(
  defineProps<{ visible: boolean; sessionId: string; path?: string }>(),
  { path: '' },
)
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const loading = ref(false)
const error = ref('')
const file = ref<ReadResult | undefined>(undefined)
/** 目录列表模式：path 为空或指向目录时展示 */
const dirPath = ref('')
const dirItems = ref<DirItem[] | undefined>(undefined)

const title = computed(() => {
  if (dirItems.value !== undefined) return dirPath.value.length === 0 ? '工作区' : dirPath.value
  return file.value?.path ?? props.path
})

const lines = computed(() => {
  const f = file.value
  if (f === undefined || (f.kind !== 'text' && f.kind !== 'markdown')) return []
  // JSON 美化：dsh 的配置文件与接口返回基本都是压缩成一行的，
  // 不美化等于给用户看一堵墙
  if (f.kind === 'text' && f.path.toLowerCase().endsWith('.json')) {
    try {
      return JSON.stringify(JSON.parse(f.text), null, 2).split('\n')
    } catch {
      return f.text.split('\n')
    }
  }
  return f.text.split('\n')
})

/** CSV 预览：按 genui 的 table 思路渲染成表格，而不是一堆逗号。 */
const csv = computed(() => {
  const f = file.value
  if (f === undefined || f.kind !== 'text' || !f.path.toLowerCase().endsWith('.csv')) return undefined
  const rows = f.text.split('\n').filter((l) => l.trim().length > 0).slice(0, 200)
  return rows.map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))
})

async function open(path: string): Promise<void> {
  const link = currentLink()
  if (link === undefined) { error.value = '尚未连接主机'; return }
  loading.value = true
  error.value = ''
  dirItems.value = undefined
  file.value = undefined
  try {
    file.value = await link.call<ReadResult>('fs.read', {
      sessionId: props.sessionId,
      // 路径相对工作区根
      path,
    })
  } catch (e) {
    // 是目录就读目录：一次请求就够判断，不必先 stat
    try {
      const list = await link.call<{ path: string; items: DirItem[] }>('fs.list', {
        sessionId: props.sessionId,
        path,
      })
      dirPath.value = list.path
      dirItems.value = list.items
    } catch (e2) {
      error.value = e2 instanceof Error ? e2.message : (e instanceof Error ? e.message : '读取失败')
    }
  } finally {
    loading.value = false
  }
}

function into(name: string): void {
  haptic('light')
  void open(dirPath.value.length === 0 ? name : `${dirPath.value}/${name}`)
}

function back(): void {
  haptic('light')
  const parent = dirPath.value.includes('/') ? dirPath.value.slice(0, dirPath.value.lastIndexOf('/')) : ''
  void openDir(parent)
}

async function openDir(path: string): Promise<void> {
  const link = currentLink()
  if (link === undefined) return
  loading.value = true
  error.value = ''
  file.value = undefined
  try {
    const list = await link.call<{ path: string; items: DirItem[] }>('fs.list', {
      sessionId: props.sessionId,
      path,
    })
    dirPath.value = list.path
    dirItems.value = list.items
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取失败'
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.visible, props.path] as const,
  ([vis, p]) => {
    if (!vis) return
    if (p !== undefined && p.length > 0) void open(p)
    else void openDir('')
  },
)

function close(): void {
  emit('update:visible', false)
}
</script>

<template>
  <view v-if="props.visible" class="mask" @tap="close">
    <view class="panel" @tap.stop>
      <view class="head">
        <view class="head-l">
          <text class="title mono">{{ title }}</text>
          <text v-if="file && (file.kind === 'text' || file.kind === 'markdown' || file.kind === 'image' || file.kind === 'binary' || file.kind === 'too-large')" class="meta mono">
            {{ humanBytes(file.size) }}<text v-if="file.kind === 'text' || file.kind === 'markdown'">{{ lines.length }} 行</text>
          </text>
        </view>
        <text class="close" @tap="close">关闭</text>
      </view>

      <view v-if="loading" class="hint">读取中…</view>
      <view v-else-if="error.length > 0" class="hint err">{{ error }}</view>

      <!-- 目录列表 -->
      <scroll-view v-else-if="dirItems !== undefined" class="body" scroll-y>
        <view v-if="dirPath.length > 0" class="row" @tap="back">
          <text class="ico">..</text>
          <text class="name t3">上一级</text>
        </view>
        <view v-for="it in dirItems" :key="it.name" class="row" @tap="into(it.name)">
          <view class="ico" :class="{ dir: it.dir }" />
          <text class="name">{{ it.name }}</text>
        </view>
        <view v-if="dirItems.length === 0" class="hint t3">空目录</view>
      </scroll-view>

      <!-- 图片 -->
      <scroll-view v-else-if="file?.kind === 'image'" class="body img-body" scroll-y>
        <image class="img" :src="file.dataUri" mode="widthFix" />
      </scroll-view>

      <!-- Markdown -->
      <scroll-view v-else-if="file?.kind === 'markdown'" class="body" scroll-y>
        <MossMarkdown :text="file.text" />
        <view v-if="file.truncated" class="hint t3">文件较大，仅显示前 20 万字符</view>
      </scroll-view>

      <!-- 代码 / 纯文本：行号 + 等宽，横向滚动保留缩进 -->
      <scroll-view v-else-if="file?.kind === 'text'" class="body code-body" scroll-x>
        <view class="code-lines">
          <view v-for="(ln, i) in lines" :key="i" class="cl">
            <text class="cl-no mono">{{ i + 1 }}</text>
            <text class="cl-src mono">{{ ln.length > 0 ? ln : ' ' }}</text>
          </view>
        </view>
      </scroll-view>

      <!-- 二进制 / 过大 -->
      <view v-else-if="file" class="hint">
        <text v-if="file.kind === 'binary'">这是二进制文件（{{ humanBytes(file.size) }}），手机端不预览。</text>
        <text v-else>文件过大（{{ humanBytes(file.size) }}），超过 2MB 不加载。</text>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-end;
}

.panel {
  width: 100%;
  max-height: 92vh;
  height: 92vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  border-top: 1px solid var(--bd-strong);
  animation: up var(--t-mid) var(--ease-out);
}

@keyframes up {
  from { transform: translateY(24px); opacity: 0.7; }
  to { transform: translateY(0); opacity: 1; }
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 14px 10px;
  border-bottom: 1px solid var(--bd);
}

.head-l { min-width: 0; }
.title { display: block; font-size: 12.5px; color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { display: block; margin-top: 3px; font-size: 10px; color: var(--t3); }
.close { flex: none; font-size: 13px; color: var(--acc); }

.body { flex: 1; padding: 10px 14px 20px; height: 0; }
.img-body { display: grid; place-items: start center; }
.img { width: 100%; border-radius: 8px; }

.hint { padding: 28px 16px; text-align: center; font-size: 12.5px; color: var(--t3); line-height: 19px; }
.hint.err { color: var(--danger); }

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 2px;
  border-bottom: 1px solid var(--bd);
}

.row:active { background: var(--s2); }

/* 文件/文件夹图标：纯 CSS，文件夹用带缺口的小方块示意 */
.ico {
  flex: none;
  width: 14px;
  height: 14px;
  border: 1.4px solid var(--t3);
  border-radius: 3px;
  position: relative;
}

.ico.dir {
  border-color: var(--acc);
  border-radius: 3px 3px 2px 2px;
}
.ico.dir::before {
  content: '';
  position: absolute;
  left: -1.4px;
  top: -5px;
  width: 7px;
  height: 3px;
  background: var(--acc);
  border-radius: 2px 2px 0 0;
}

.name { flex: 1; min-width: 0; font-size: 13px; color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* CSV 表格：首行当表头，单元格不换行（横向滚动） */
.tbl { display: inline-block; min-width: 100%; }
.tr { display: flex; border-bottom: 1px solid var(--bd); }
.tr.th { background: var(--s2); }
.td {
  flex: none;
  min-width: 84px;
  max-width: 220px;
  padding: 7px 10px;
  font-size: 11.5px;
  color: var(--t2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tr.th .td { color: var(--t1); font-weight: 600; }

/* 代码：行号固定宽，源码不换行（横向滚动） */
.code-body { padding-bottom: 24px; }
.code-lines { display: inline-block; min-width: 100%; }

.cl { display: flex; gap: 10px; }
.cl-no {
  flex: none;
  width: 34px;
  text-align: right;
  font-size: 10.5px;
  line-height: 18px;
  color: var(--t3);
  user-select: none;
}
.cl-src {
  flex: 1;
  font-size: 11.5px;
  line-height: 18px;
  color: var(--t2);
  white-space: pre;
}
</style>
