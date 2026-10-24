<script setup lang="ts">
/**
 * dsh-genui 组件的手机端渲染（子集）。
 *
 * 支持：text / list / table / keyvalue / callout / stat / divider / code /
 * json / steps / badge / chart(bars)。
 *
 * 不支持的类型在解析阶段就被丢弃，并在底部提示"还有 N 个组件未渲染"——
 * 明确告知比假装渲染完整更诚实。
 */
import { computed } from 'vue'
import { arr, chartPoints, choice, num, pairs, parseGenui, str, table, type GenuiNode } from '@/core/genui'

const props = defineProps<{ raw: string }>()
/** 选项式提问：把用户的选择抛给上层，由它作为一条消息发回宿主。 */
const emit = defineEmits<{ (e: 'answer', text: string): void }>()

function pick(label: string): void {
  emit('answer', label)
}

const parsed = computed(() => parseGenui(props.raw))

const text = (n: GenuiNode, k = 'content'): string => str(n, k)
const listItems = (n: GenuiNode): string[] => arr(n, 'items').map((x) => String(x))
const stepList = (n: GenuiNode): string[] => {
  const out: string[] = []
  for (const raw of arr(n, 'steps')) {
    if (typeof raw === 'object' && raw !== null) out.push(String((raw as { title?: unknown }).title ?? ''))
    else out.push(String(raw))
  }
  return out.filter((x) => x.length > 0)
}

/** 柱状图最大值，用于算宽度百分比 */
function maxOf(points: readonly { value: number }[]): number {
  return points.reduce((m, p) => Math.max(m, Math.abs(p.value)), 0) || 1
}
</script>

<template>
  <view v-if="parsed === undefined" class="genui-raw">
    <text class="raw-text mono">{{ props.raw.slice(0, 400) }}</text>
  </view>

  <view v-else class="genui" :style="{ gap: (parsed.spec.gap ?? 10) + 'px' }">
    <view v-if="(parsed.spec.title ?? '').length > 0" class="g-title">{{ parsed.spec.title }}</view>

    <template v-for="(node, i) in parsed.spec.items" :key="i">
      <text v-if="node.type === 'text'" class="g-text">{{ text(node) }}</text>

      <view v-else-if="node.type === 'divider'" class="g-hr" />

      <view v-else-if="node.type === 'badge'" class="g-badge">
        <text>{{ text(node) }}</text>
      </view>

      <view v-else-if="node.type === 'list'" class="g-list">
        <view v-for="(it, j) in listItems(node)" :key="j" class="g-li">
          <text class="g-dot">·</text>
          <text class="g-li-t">{{ it }}</text>
        </view>
      </view>

      <view v-else-if="node.type === 'steps'" class="g-steps">
        <view v-for="(st, j) in stepList(node)" :key="j" class="g-step">
          <text class="g-step-no mono">{{ j + 1 }}</text>
          <text class="g-step-t">{{ st }}</text>
        </view>
      </view>

      <view v-else-if="node.type === 'callout'" class="g-callout" :class="str(node, 'tone')">
        <text>{{ text(node) }}</text>
      </view>

      <view v-else-if="node.type === 'stat'" class="g-stat">
        <text class="g-stat-label">{{ str(node, 'label') }}</text>
        <text class="g-stat-value">{{ str(node, 'value') }}</text>
      </view>

      <view v-else-if="node.type === 'keyvalue'" class="g-kv">
        <view v-for="(p, j) in pairs(node)" :key="j" class="g-kv-row">
          <text class="g-kv-k">{{ p.key }}</text>
          <text class="g-kv-v">{{ p.value }}</text>
        </view>
      </view>

      <scroll-view v-else-if="node.type === 'table'" class="g-table-wrap" scroll-x>
        <view v-if="table(node)" class="g-table">
          <view class="g-tr g-th">
            <text v-for="(c, j) in table(node)!.columns" :key="j" class="g-td">{{ c }}</text>
          </view>
          <view v-for="(row, ri) in table(node)!.rows" :key="ri" class="g-tr">
            <text v-for="(c, j) in row" :key="j" class="g-td">{{ c }}</text>
          </view>
        </view>
      </scroll-view>

      <view v-else-if="node.type === 'chart'" class="g-chart">
        <view v-for="(p, j) in chartPoints(node)" :key="j" class="g-bar-row">
          <text class="g-bar-label">{{ p.label }}</text>
          <view class="g-bar-track">
            <view class="g-bar" :style="{ width: Math.max(2, Math.round((Math.abs(p.value) / maxOf(chartPoints(node))) * 100)) + '%' }" />
          </view>
          <text class="g-bar-v mono">{{ p.value }}</text>
        </view>
      </view>

      <!-- 选项式提问：点一下就作为回答发出 -->
      <view v-else-if="node.type === 'choice' && choice(node)" class="g-choice">
        <text class="g-q">{{ choice(node)!.question }}</text>
        <view class="g-options">
          <view v-for="(o, j) in choice(node)!.options" :key="j" class="g-opt" @tap="pick(o.label)">
            <text>{{ o.label }}</text>
          </view>
        </view>
      </view>

      <view v-else-if="node.type === 'code'" class="g-code">
        <text class="g-code-lang mono">{{ str(node, 'lang') }}</text>
        <text class="g-code-t mono">{{ str(node, 'content') || str(node, 'value') }}</text>
      </view>

      <view v-else-if="node.type === 'json'" class="g-code">
        <text class="g-code-t mono">{{ str(node, 'content') || JSON.stringify(node['value'] ?? node['data']) }}</text>
      </view>
    </template>

    <view v-if="parsed.skipped > 0" class="g-skip">
      <text>还有 {{ parsed.skipped }} 个组件手机端未支持，可在电脑上查看</text>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.genui {
  display: flex;
  flex-direction: column;
  margin: 10px 0;
  padding: 12px;
  border: 1px solid var(--bd);
  border-radius: 10px;
  background: var(--s1);
}

.raw-text { font-size: 11px; color: var(--t3); white-space: pre-wrap; }

.g-title { font-size: 13px; font-weight: 600; color: var(--t1); }
.g-text { font-size: 13px; line-height: 20px; color: var(--t1); }
.g-hr { height: 1px; background: var(--bd); }

.g-badge {
  align-self: flex-start;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--acc-soft);
}
.g-badge text { font-size: 11px; color: var(--acc); }

.g-list { display: flex; flex-direction: column; gap: 4px; }
.g-li { display: flex; gap: 6px; }
.g-dot { color: var(--t3); font-size: 13px; }
.g-li-t { flex: 1; font-size: 12.5px; line-height: 19px; color: var(--t1); }

.g-steps { display: flex; flex-direction: column; gap: 6px; }
.g-step { display: flex; gap: 8px; align-items: flex-start; }
.g-step-no {
  flex: none;
  width: 16px; height: 16px;
  margin-top: 1px;
  border-radius: 8px;
  text-align: center;
  font-size: 9px;
  line-height: 16px;
  background: var(--acc-soft);
  color: var(--acc);
}
.g-step-t { flex: 1; font-size: 12.5px; line-height: 19px; color: var(--t1); }

.g-callout {
  padding: 8px 10px;
  border-radius: 8px;
  border-left: 2px solid var(--acc);
  background: var(--acc-soft);
}
.g-callout text { font-size: 12px; line-height: 18px; color: var(--t2); }
.g-callout.warning { border-left-color: var(--warn, #e6b43c); }
.g-callout.error { border-left-color: var(--danger); }

.g-stat { display: flex; flex-direction: column; gap: 2px; }
.g-stat-label { font-size: 10.5px; color: var(--t3); }
.g-stat-value { font-size: 19px; font-weight: 700; color: var(--t1); }

.g-kv { display: flex; flex-direction: column; gap: 5px; }
.g-kv-row { display: flex; gap: 10px; justify-content: space-between; }
.g-kv-k { font-size: 11.5px; color: var(--t3); }
.g-kv-v { font-size: 11.5px; color: var(--t1); text-align: right; }

.g-table-wrap { max-width: 100%; }
.g-table { display: inline-block; min-width: 100%; }
.g-tr { display: flex; border-bottom: 1px solid var(--bd); }
.g-th { background: var(--s2); }
.g-td {
  flex: none;
  min-width: 78px;
  max-width: 200px;
  padding: 7px 9px;
  font-size: 11.5px;
  color: var(--t2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.g-th .g-td { color: var(--t1); font-weight: 600; }

.g-chart { display: flex; flex-direction: column; gap: 6px; }
.g-bar-row { display: flex; align-items: center; gap: 8px; }
.g-bar-label { flex: none; width: 66px; font-size: 10.5px; color: var(--t3); }
.g-bar-track { flex: 1; height: 8px; border-radius: 4px; background: var(--s2); overflow: hidden; }
.g-bar { height: 8px; border-radius: 4px; background: var(--acc); }
.g-bar-v { flex: none; width: 48px; text-align: right; font-size: 10px; color: var(--t3); }

.g-choice { display: flex; flex-direction: column; gap: 8px; }
.g-q { font-size: 13px; line-height: 20px; color: var(--t1); }
.g-options { display: flex; flex-direction: column; gap: 7px; }
.g-opt {
  padding: 9px 12px;
  border-radius: 9px;
  border: 1px solid var(--acc);
  background: var(--acc-soft);
}
.g-opt:active { background: var(--s2); }
.g-opt text { font-size: 12.5px; color: var(--acc); }

.g-code { padding: 9px 10px; border-radius: 8px; background: var(--bg); border: 1px solid var(--bd); }
.g-code-lang { display: block; font-size: 9px; color: var(--t3); margin-bottom: 5px; }
.g-code-t { font-size: 11px; line-height: 17px; color: var(--t2); white-space: pre; }

.g-skip text { font-size: 10.5px; color: var(--t3); }
</style>
