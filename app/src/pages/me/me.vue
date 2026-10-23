<script setup lang="ts">
/**
 * 我的：外观 + 安全 + 关于。
 *
 * 外观放在最上面不是因为它重要，是因为它最能被玩——
 * 换皮肤是这个 App 唯一"一眼看出不同"的设置，把它放在第一屏能立刻传达设计语言。
 *
 * 锁屏策略在这里是**只读展示**：真正的开关在 PC 上（那是 PC 的安全边界，
 * 手机改它等于把锁的钥匙挂在门外）。
 */
import { computed } from 'vue'
import PageShell from '@/components/PageShell.vue'
import { state, skin, markUserPreference, type SkinMode } from '@/core/store'
import { haptic } from '@/core/haptic'

const skins: { key: SkinMode; name: string; desc: string; dot: string }[] = [
  // desc 必须说人话，而且要说得准：
  // auto 的规则是"只有锁屏与危险确认整页切 550W"，
  // 不是"有事等你"——那样红色会成为常态，警示就失效了（docs/05 §2）
  { key: 'auto', name: '跟随语义', desc: '锁屏与危险确认 → 红，其余 → 绿', dot: 'linear-gradient(90deg,#46e3a6 50%,#ff3b2f 50%)' },
  { key: 'moss', name: 'MOSS', desc: '冷青绿 · 连接与正常', dot: '#46e3a6' },
  { key: '550w', name: '550W', desc: '血橙红 · 待机与告警', dot: '#ff3b2f' },
]

const currentSkin = computed(() => skins.find((s) => s.key === state.skinMode) ?? skins[0]!)

/** 右上角的皮肤指示：选了"跟随"就不能只显示解析结果，否则用户以为已经手动选定了 */
const skinLabel = computed(() => {
  const resolved = skin.value === 'moss' ? 'MOSS' : '550W'
  return state.skinMode === 'auto' ? `跟随 · ${resolved}` : resolved
})

// 每次改动都标记为"用户亲手选的"：这一位决定冷启动时是否跟随系统主题。
// 少了它，浅色模式当时生效、重启被系统改回——表现为"配置没生效"。
function pickSkin(k: SkinMode): void {
  haptic('light')
  state.skinMode = k
  markUserPreference('skin')
}

function toggleLight(): void {
  haptic('light')
  state.light = !state.light
  markUserPreference('light')
}

function toggleLite(): void {
  haptic('light')
  state.lite = !state.lite
  markUserPreference('lite')
}

function goTab(tab: 'devices' | 'sessions' | 'me'): void {
  const map = { devices: '/pages/index/index', sessions: '/pages/sessions/sessions', me: '/pages/me/me' }
  uni.reLaunch({ url: map[tab] })
}

function about(): void {
  uni.showModal({
    title: 'MOSS LINK 0.1.0',
    content: '数据不经过任何服务器。\n锁屏挡住的是人，不是进程。',
    showCancel: false,
    confirmText: '知道了',
  })
}
</script>

<template>
  <PageShell active="me" @tab="goTab">
    <view class="head safe-top">
      <text class="h1">我的</text>
      <text class="mono t3">{{ skinLabel }}</text>
    </view>

    <view class="scroll">
      <view class="sect"><text>外观</text></view>

      <view class="panel">
        <view
          v-for="s in skins"
          :key="s.key"
          class="opt"
          :class="{ on: state.skinMode === s.key }"
          @tap="pickSkin(s.key)"
        >
          <view class="swatch" :style="{ background: s.dot }" />
          <view class="opt-body">
            <text class="opt-n">{{ s.name }}</text>
            <text class="opt-d t3">{{ s.desc }}</text>
          </view>
          <view class="check" :class="{ on: state.skinMode === s.key }" />
        </view>

        <view class="hairline" />

        <view class="opt" @tap="toggleLight">
          <view class="swatch lt" />
          <view class="opt-body">
            <text class="opt-n">浅色模式</text>
            <text class="opt-d t3">亮底会关掉扫描线与发光</text>
          </view>
          <view class="switch" :class="{ on: state.light }"><view class="knob" /></view>
        </view>

        <view class="opt" @tap="toggleLite">
          <view class="swatch lite" />
          <view class="opt-body">
            <text class="opt-n">省电渲染</text>
            <text class="opt-d t3">关噪点与呼吸动画（低端机自动开）</text>
          </view>
          <view class="switch" :class="{ on: state.lite }"><view class="knob" /></view>
        </view>
      </view>

      <view class="sect"><text>安全</text></view>

      <view class="panel">
        <view class="row-static">
          <view class="row-hd">
            <text class="opt-n">锁屏策略</text>
            <text class="chip mono">dsh 侧</text>
          </view>
          <text class="opt-d t3">
            空闲 10 分钟自动锁 · 5 次失败限速 5 分钟 · 8 小时转只读
          </text>
          <view class="note">
            <text class="note-t">锁屏挡住的是人，不是进程。</text>
            <text class="note-d t3">
              它防止别人看到你的会话或顺手操作，不能阻止本机上已经拿到权限的程序。
              正在运行的任务不会因为锁屏而暂停。
            </text>
          </view>
        </view>

        <view class="row-static">
          <text class="opt-n">解锁方式</text>
          <text class="opt-d t3">密码 · Touch ID / Windows Hello · 恢复码</text>
        </view>

        <view class="row-static">
          <text class="opt-n">审计</text>
          <text class="opt-d t3">锁定 / 解锁成功与失败都会留痕，只追加不修改</text>
        </view>
      </view>

      <view class="sect"><text>关于</text></view>

      <view class="panel">
        <view class="opt" @tap="about">
          <view class="opt-body">
            <text class="opt-n">MOSS LINK 0.1.0</text>
            <text class="opt-d t3">dsh-link · 宿主插件 0.1.0</text>
          </view>
          <text class="mono t3">›</text>
        </view>

        <!-- 品牌区：把 MOSS 主体放进来，让"关于"页有可识别的主体而不是纯文字 -->
        <view class="brand-card">
          <image class="brand-img" src="/static/moss/hero.webp" mode="aspectFit" />
          <view class="brand-body">
            <text class="brand-h mark mono">MOSS<span class="brand-acc">LINK</span></text>
            <text class="brand-d t3">把 dsh 带到手机上</text>
          </view>
        </view>
      </view>

      <view class="foot t3">
        <text class="mono">NO CLOUD / NO ACCOUNT</text>
      </view>
    </view>
  </PageShell>
</template>

<style lang="scss" scoped>
.brand-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 13px;
  border-top: 1px solid var(--bd);
}

.brand-img { width: 64px; height: 64px; flex: none; }
.brand-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.brand-h { font-size: 15px; font-weight: 700; letter-spacing: 1.6px; color: var(--t1); }
.brand-acc { color: var(--acc); }
.brand-d { font-size: 11.5px; }

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding-right: 16px;
  padding-bottom: 8px;
  padding-left: 16px;
  /* 刻意不用 padding 简写：简写会把 padding-top 重置为 0，
     覆盖掉 .head 上的 .safe-top（状态栏安全区）。 */
}

.h1 { font-size: 21px; font-weight: 700; }

/* 底部安全距离由 moss.scss 的 .scroll 统一给，这里只管左右 */
.scroll { padding-left: 12px; padding-right: 12px; }

.panel {
  border-radius: var(--r-md);
  border: 1px solid var(--bd);
  background: var(--s1);
  overflow: hidden;
}

.opt {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 13px;
  min-height: 56px;
}

.opt:active { background: var(--s2); }

.swatch {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  flex: 0 0 26px;
  border: 1px solid var(--bd);
}

/* 浅色的示意块不能是纯白：深色界面上一个 #fff 方块看起来像图片没加载出来 */
.swatch.lt { background: linear-gradient(135deg, #dfe9e4 50%, #ece2d2 50%); }
.swatch.lite { background: repeating-linear-gradient(45deg, var(--s3) 0 3px, var(--s2) 3px 6px); }

.opt-body { flex: 1; min-width: 0; }
.opt-n { font-size: 14px; display: block; }
.opt-d { display: block; margin-top: 3px; font-size: 11.5px; line-height: 16px; }

.check {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid var(--bd);
  flex: 0 0 18px;
}

.check.on { border-color: var(--acc); background: var(--acc); box-shadow: inset 0 0 0 3px var(--s1); }

.switch {
  width: 42px;
  height: 25px;
  border-radius: 13px;
  background: var(--s3);
  border: 1px solid var(--bd);
  position: relative;
  flex: 0 0 42px;
  transition: background var(--t-fast);
}

.switch.on { background: var(--acc); border-color: transparent; }

.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  background: var(--t2);
  transition: transform var(--t-fast) var(--ease-out), background var(--t-fast);
}

.switch.on .knob { transform: translateX(17px); background: var(--acc-ink); }

.row-static { padding: 13px; border-bottom: 1px solid var(--bd); }
.row-static:last-child { border-bottom: 0; }
.row-hd { display: flex; align-items: center; gap: 8px; }

.chip {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--acc-soft);
  color: var(--acc);
  font-size: 9.5px;
  letter-spacing: 0.4px;
}

.note {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  border-left: 2px solid var(--warn);
  background: var(--warn-soft);
}

.note-t { display: block; font-size: 12px; color: var(--warn); }
.note-d { display: block; margin-top: 5px; font-size: 11px; line-height: 17px; }

.foot { margin: 26px 0; text-align: center; font-size: 10px; letter-spacing: 1.2px; opacity: 0.6; }
</style>
