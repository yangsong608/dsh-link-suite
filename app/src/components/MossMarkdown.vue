<script setup lang="ts">
/**
 * Markdown 渲染。
 *
 * 为什么不用 rich-text：那玩意儿对样式几乎不可控——代码块会丢等宽字体、
 * 列表缩进按平台各异、行内代码没有底色。agent 的回答里代码与列表占多数，
 * 渲染不好就等于没渲染。
 *
 * 这里用 view/text 逐块自己画，样式全部走 token，明暗与两套皮肤自动跟随。
 */
import { computed } from 'vue'
import { looksLikeMarkdown, parseMarkdown, type Inline } from '@/core/markdown'

const props = withDefaults(defineProps<{ text: string }>(), { text: '' })

const blocks = computed(() => {
  const src = props.text ?? ''
  if (src.length === 0) return []
  // 纯文本不值得解析：省一次遍历，也让纯文字气泡少一层节点
  return looksLikeMarkdown(src) ? parseMarkdown(src) : [{ t: 'p' as const, inline: [{ t: 'text' as const, v: src }] }]
})

/** 行内片段拆成可 v-for 的数组（模板里不能直接写类型收窄）。 */
function segments(inline: readonly Inline[]): readonly Inline[] {
  return inline
}

/** 行内 token → 类名。code 单独命名，避免和代码块块级样式撞车。 */
function cls(seg: Inline): string {
  return seg.t === 'code' ? 'icode' : seg.t
}
</script>

<template>
  <view class="md">
    <template v-for="(b, i) in blocks" :key="i">
      <!-- 代码块：等宽 + 横向滚动，不换行（换行会破坏缩进语义） -->
      <scroll-view v-if="b.t === 'code'" class="code-wrap" scroll-x>
        <view class="code-block">
          <text v-if="b.lang.length > 0" class="code-lang mono">{{ b.lang }}</text>
          <text class="code-text mono">{{ b.text }}</text>
        </view>
      </scroll-view>

      <view v-else-if="b.t === 'hr'" class="hr" />

      <!-- dsh-ui fence：本端不实现 genui 组件集，给一张说明卡而不是糊一屏 JSON -->
      <view v-else-if="b.t === 'genui'" class="genui">
        <view class="genui-head">
          <text class="genui-badge mono">GENUI</text>
          <text class="genui-t">结构化 UI</text>
        </view>
        <text class="genui-d">电脑端 DSH 已把它渲染成可交互组件；手机端暂以文字呈现，可在电脑上查看。</text>
        <scroll-view class="genui-raw" scroll-y scroll-x>
          <text class="genui-code mono">{{ b.raw.length > 400 ? b.raw.slice(0, 400) + '…' : b.raw }}</text>
        </scroll-view>
      </view>

      <view v-else-if="b.t === 'quote'" class="quote">
        <text v-for="(s, j) in segments(b.inline)" :key="j" class="q-text" :class="cls(s)">{{ s.v }}</text>
      </view>

      <view v-else-if="b.t === 'ul'" class="list">
        <view v-for="(item, j) in b.items" :key="j" class="li">
          <text class="li-dot">·</text>
          <text class="li-text">
            <text v-for="(s, k) in segments(item)" :key="k" :class="cls(s)">{{ s.v }}</text>
          </text>
        </view>
      </view>

      <view v-else-if="b.t === 'ol'" class="list">
        <view v-for="(item, j) in b.items" :key="j" class="li">
          <text class="li-num mono">{{ b.start + j }}.</text>
          <text class="li-text">
            <text v-for="(s, k) in segments(item)" :key="k" :class="cls(s)">{{ s.v }}</text>
          </text>
        </view>
      </view>

      <text v-else-if="b.t === 'h'" class="h" :class="'h' + b.level">
        <text v-for="(s, k) in segments(b.inline)" :key="k" :class="cls(s)">{{ s.v }}</text>
      </text>

      <text v-else class="p">
        <text v-for="(s, k) in segments(b.inline)" :key="k" :class="cls(s)">{{ s.v }}</text>
      </text>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.md { display: block; }

.p {
  display: block;
  font-size: var(--fs-body, 14px);
  line-height: 1.64;
  color: var(--t1);
  white-space: pre-wrap;
  word-break: break-word;
}

.p + .p, .p + .list, .list + .p { margin-top: 8px; }

/* 行内代码：底色 + 等宽，与正文明显区分 */
.icode {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 0.92em;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--s3);
  color: var(--acc);
}

.bold { font-weight: 700; color: var(--t1); }
.italic { font-style: italic; }
.link { color: var(--acc); text-decoration: underline; }

/* 代码块：整块底色 + 横向滚动 */
.code-wrap {
  margin: 8px 0;
  border-radius: 10px;
  border: 1px solid var(--bd);
  background: var(--s1);
  overflow: hidden;
}

.code-block {
  padding: 10px 12px;
  /* 让内容自己撑开，scroll-x 才有可滚区域 */
  display: inline-block;
  min-width: 100%;
  box-sizing: border-box;
}

.code-lang {
  display: block;
  font-size: 9.5px;
  color: var(--t3);
  letter-spacing: 0.6px;
  margin-bottom: 6px;
  text-transform: uppercase;
}

.code-text {
  display: block;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.62;
  color: var(--t2);
  white-space: pre;
}

.h { display: block; color: var(--t1); font-weight: 700; margin: 10px 0 6px; }
.h1 { font-size: 17px; }
.h2 { font-size: 15.5px; }
.h3 { font-size: 14.5px; }

.list { margin: 6px 0; }
.li { display: flex; gap: 6px; padding: 2px 0; }
.li-dot, .li-num { flex: none; color: var(--t3); font-size: var(--fs-body, 14px); line-height: 1.64; min-width: 14px; }
.li-text { flex: 1; min-width: 0; font-size: var(--fs-body, 14px); line-height: 1.64; color: var(--t1); word-break: break-word; }

.quote {
  margin: 8px 0;
  padding: 6px 10px;
  border-left: 2px solid var(--acc);
  background: var(--acc-soft);
  border-radius: 0 6px 6px 0;
}
.q-text { font-size: 13px; line-height: 1.6; color: var(--t2); }

.hr { height: 1px; margin: 12px 0; background: var(--bd); }

/* genui 降级卡：明确"有内容但我渲染不了"，而不是假装它是普通代码 */
.genui {
  margin: 10px 0;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--bd);
  background: var(--s1);
}

.genui-head { display: flex; align-items: center; gap: 7px; }
.genui-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--acc-soft);
  color: var(--acc);
  letter-spacing: 0.6px;
}
.genui-t { font-size: 12px; color: var(--t1); }
.genui-d { display: block; margin-top: 6px; font-size: 11px; line-height: 16px; color: var(--t3); }
.genui-raw { max-height: 96px; margin-top: 8px; }
.genui-code { font-size: 10.5px; line-height: 15px; color: var(--t3); white-space: pre; }
</style>
