<script setup lang="ts">
/**
 * 统一弹层：菜单 / 确认 / 输入，三种形态一套样式。
 *
 * 为什么不用 uni.showActionSheet / showModal：
 *   1. 原生样式与本应用的 MOSS 视觉完全两张皮（白底圆角、蓝色文字），
 *      在深色终端风里像误闯进来的对话框；
 *   2. showActionSheet 在部分平台**最多只显示 6 项**，超出的静默丢弃。
 *      模型列表动辄十几个，用户点"选模型"没任何反应就是这个原因；
 *   3. 原生弹层不能加说明文字，用户无法判断"这项会做什么"。
 *
 * 设计约定：
 *   - 从底部升起（拇指可达），顶部圆角，遮罩点击关闭
 *   - 危险项（删除/移除）用 --danger 色，并永远排在最后、与普通项之间留分隔
 *   - 每项可带 hint，用一句话说明后果
 */
import { computed, ref, watch } from 'vue'
import { haptic } from '@/core/haptic'

export interface SheetItem {
  readonly label: string
  /** 一句话说明这项会做什么（可选） */
  readonly hint?: string
  /** 危险操作：红色 + 分隔 */
  readonly danger?: boolean
}

const props = withDefaults(
  defineProps<{
    visible: boolean
    title?: string
    /** menu：选项列表；confirm：确认；prompt：带输入框 */
    kind?: 'menu' | 'confirm' | 'prompt'
    items?: readonly SheetItem[]
    /** confirm / prompt 的正文 */
    message?: string
    /** prompt 的初值 */
    value?: string
    placeholder?: string
    confirmText?: string
    cancelText?: string
    /** prompt 是否多行 */
    multiline?: boolean
  }>(),
  {
    kind: 'menu',
    items: () => [],
    message: '',
    value: '',
    placeholder: '',
    confirmText: '确定',
    cancelText: '取消',
    multiline: false,
  },
)

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  /** menu 选中某项 */
  (e: 'select', index: number): void
  /** confirm 确认 / prompt 提交（带文本） */
  (e: 'confirm', text: string): void
  (e: 'cancel'): void
}>()

const draft = ref(props.value)

watch(
  () => [props.visible, props.value] as const,
  ([vis]) => {
    if (vis) draft.value = props.value
  },
)

/** 危险项之前插一条分隔线：让"删"和"改"在触觉上分开 */
const withDividers = computed(() => {
  const list = props.items
  const out: { item: SheetItem; index: number; divider: boolean }[] = []
  let lastWasNormal = false
  list.forEach((item, index) => {
    const divider = item.danger === true && lastWasNormal
    out.push({ item, index, divider })
    lastWasNormal = item.danger !== true
  })
  return out
})

function close(): void {
  emit('update:visible', false)
}

function cancel(): void {
  haptic('light')
  emit('cancel')
  close()
}

function pick(index: number): void {
  haptic('light')
  emit('select', index)
  close()
}

function submit(): void {
  haptic('medium')
  emit('confirm', draft.value)
  close()
}

function ok(): void {
  haptic('medium')
  emit('confirm', '')
  close()
}
</script>

<template>
  <view v-if="props.visible" class="mask" @tap="cancel">
    <view class="sheet" @tap.stop>
      <view class="grab" />

      <view v-if="props.title !== undefined && props.title.length > 0" class="head">
        <text class="title">{{ props.title }}</text>
      </view>

      <!-- 菜单 -->
      <scroll-view v-if="props.kind === 'menu'" class="list" scroll-y>
        <template v-for="row in withDividers" :key="row.index">
          <view v-if="row.divider" class="sep" />
          <view class="item" :class="{ danger: row.item.danger === true }" @tap="pick(row.index)">
            <view class="item-body">
              <text class="item-label">{{ row.item.label }}</text>
              <text v-if="row.item.hint" class="item-hint">{{ row.item.hint }}</text>
            </view>
            <view class="chev" />
          </view>
        </template>
        <view v-if="withDividers.length === 0" class="empty">没有可选项</view>
      </scroll-view>

      <!-- 确认 -->
      <view v-else-if="props.kind === 'confirm'" class="body">
        <text class="msg">{{ props.message }}</text>
      </view>

      <!-- 输入 -->
      <view v-else class="body">
        <text v-if="props.message.length > 0" class="msg">{{ props.message }}</text>
        <textarea
          v-if="props.multiline"
          v-model="draft"
          class="input area"
          :placeholder="props.placeholder"
          placeholder-class="ph"
          :maxlength="400"
        />
        <input
          v-else
          v-model="draft"
          class="input"
          :placeholder="props.placeholder"
          placeholder-class="ph"
          :maxlength="120"
        />
      </view>

      <!-- 操作区：confirm / prompt 才有 -->
      <view v-if="props.kind !== 'menu'" class="actions">
        <view class="btn ghost" @tap="cancel">
          <text>{{ props.cancelText }}</text>
        </view>
        <view class="btn primary" @tap="props.kind === 'prompt' ? submit() : ok()">
          <text>{{ props.confirmText }}</text>
        </view>
      </view>

      <!-- 菜单底部单独的取消条：与选项区分开，避免误触第一项 -->
      <view v-if="props.kind === 'menu'" class="cancel-bar" @tap="cancel">
        <text>{{ props.cancelText }}</text>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: flex-end;
  /* 遮罩淡入，避免"啪"地出现 */
  animation: mask-in 160ms var(--ease-out);
}

@keyframes mask-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.sheet {
  width: 100%;
  /* 平板上不要让弹层横跨整屏：居中受限更好读 */
  max-width: 520px;
  margin: 0 auto;
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-top: 1px solid var(--bd-strong);
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  padding-bottom: calc(8px + var(--safe-bottom-real, 0px));
  animation: sheet-up var(--t-mid) var(--ease-out);
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.5);
}

@keyframes sheet-up {
  from { transform: translateY(18px); opacity: 0.6; }
  to { transform: translateY(0); opacity: 1; }
}

.grab {
  width: 34px;
  height: 3px;
  border-radius: 2px;
  background: var(--bd-strong);
  margin: 8px auto 4px;
}

.head { padding: 6px 16px 2px; }
.title { font-size: 14px; color: var(--t1); font-weight: 600; }

.list { max-height: 52vh; padding: 4px 8px 0; }

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 10px;
  border-radius: 10px;
}

.item:active { background: var(--s2); }

.item-body { flex: 1; min-width: 0; }
.item-label { display: block; font-size: 14px; color: var(--t1); }
.item-hint { display: block; margin-top: 3px; font-size: 11px; color: var(--t3); line-height: 15px; }

.item.danger .item-label { color: var(--danger); }

.sep { height: 1px; margin: 6px 10px; background: var(--bd); }

.chev {
  flex: none;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid var(--t3);
  border-top: 1.5px solid var(--t3);
  transform: rotate(45deg);
}

.body { padding: 10px 16px 4px; }
.msg { font-size: 13px; color: var(--t2); line-height: 20px; }

.input {
  margin-top: 12px;
  height: 44px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--bd);
  background: var(--s1);
  color: var(--t1);
  font-size: 14px;
}

.input.area { height: 108px; padding: 10px 12px; }

.ph { color: var(--t3); }

.actions {
  display: flex;
  gap: 10px;
  padding: 14px 16px 6px;
}

.btn {
  flex: 1;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 600;
}

/* 取消在左、主操作在右；危险操作由调用方把 confirmText 写成"删除" */
.btn.ghost {
  border: 1px solid var(--bd);
  color: var(--t2);
  background: var(--s1);
}

.btn.primary {
  background: var(--acc);
  color: var(--acc-ink);
}

.cancel-bar {
  margin: 8px 16px 4px;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  border: 1px solid var(--bd);
  color: var(--t2);
  font-size: 14px;
}

.cancel-bar:active { background: var(--s2); }

.empty { padding: 24px 0; text-align: center; color: var(--t3); font-size: 12.5px; }

/* 减少动效偏好 */
@media (prefers-reduced-motion: reduce) {
  .mask, .sheet { animation: none; }
}
</style>
