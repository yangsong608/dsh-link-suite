/**
 * 领域类型：宿主与 App 两侧共用的"数据长什么样"。
 *
 * 一条纪律：**这里只放跨进程的形状**。宿主内部的实现细节（比如 dsh 的 Session 对象）
 * 不许泄漏进来——一旦泄漏，dsh 小版本升级就会改到这里。
 */

import type { Caps } from './methods.js'

export type DeviceRole = 'viewer' | 'operator' | 'approver' | 'admin'

export interface DeviceInfo {
  readonly deviceId: string
  readonly name: string
  readonly platform: 'ios' | 'android' | 'harmony' | 'web' | 'desktop'
  readonly role: DeviceRole
  readonly createdAt: number
  readonly lastSeen: number
  readonly revokedAt?: number
}

export interface HostInfo {
  readonly hostId: string
  readonly name: string
  readonly platform: string
  readonly dshVersion: string
  readonly linkVersion: string
  readonly caps: Caps
  /** 当前锁屏状态。设备卡用它区分「已锁定」与「离线」。 */
  readonly lock: LockState
}

// ── 锁屏 ──────────────────────────────────────────────────────────────────

/**
 * 锁屏状态。**唯一来源是宿主**（client 半与网关都只读它），
 * 因此不存在"两处状态不同步"这类经典 bug。见 docs/06 §4.3。
 */
export interface LockState {
  readonly locked: boolean
  /** 只读半锁：能看不能动。用于"人走了但任务还在跑"的场景。 */
  readonly soft: boolean
  readonly since?: number
  readonly reason?: LockReason
  readonly failedAttempts: number
  /** 还剩几次尝试；服务端算，客户端不自己数。 */
  readonly attemptsLeft?: number
  /** 距离可再次尝试的毫秒数（限速中）；0 表示不限制。 */
  readonly retryAfterMs?: number
}

export type LockReason = 'idle' | 'manual' | 'remote' | 'boot'

export const UNLOCKED: LockState = { locked: false, soft: false, failedAttempts: 0 }

// ── 工作区与会话 ──────────────────────────────────────────────────────────

export interface WorkspaceSummary {
  readonly id: string
  readonly name: string
  /** 宿主机上的绝对路径。App 只展示尾部，不拼 URL。 */
  readonly path: string
  readonly pinned: boolean
  readonly sessionCount: number
  readonly updatedAt: number
}

export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'waiting-input' | 'done' | 'error'

export interface SessionSummary {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly status: SessionStatus
  readonly updatedAt: number
  readonly model?: string
  /** 一句话摘要：手机列表只显示这一行，展开才拉全文。 */
  readonly excerpt?: string
}

/** 会话流里的一帧。刻意做成"可渲染的粗粒度块"，而不是 dsh 的原始事件。 */
export type StreamItem =
  | { readonly k: 'user'; readonly text: string; readonly at: number }
  | { readonly k: 'assist'; readonly text: string; readonly at: number; readonly streaming?: boolean }
  | { readonly k: 'activity'; readonly tool: string; readonly summary: string; readonly ms?: number; readonly ok?: boolean }
  | { readonly k: 'approval'; readonly id: string; readonly cmd: string; readonly risk?: string }
  | { readonly k: 'question'; readonly id: string; readonly q: string; readonly options: readonly string[]; readonly multi: boolean }
  | { readonly k: 'done'; readonly at: number; readonly ok: boolean }

// ── 执行过程（trace）──────────────────────────────────────────────────────

/**
 * 执行过程条目：比 StreamItem 细一档，给"看它到底在干什么"用。
 *
 * 与 StreamItem 的分工：
 *   - StreamItem = 聊天页要渲染的气泡/卡片（用户视角的对话）
 *   - TraceItem  = 执行详情页要渲染的每一步（审计视角的过程）
 * 后者是前者的超集。聊天页从 trace 里挑 `text` / `approval` / `question` 投影即可，
 * 不要反过来从 StreamItem 反推 trace——信息已经丢了。
 */
export type TraceKind = 'think' | 'text' | 'tool' | 'file' | 'term' | 'approval' | 'question' | 'error' | 'note'

interface TraceBase {
  /** 会话内单调递增；断线重连时用 `since` 续传，不靠时间戳。 */
  readonly seq: number
  readonly at: number
  /**
   * 被裁剪过：宿主处于只读半锁时，正文类字段（input/output/tail/text）会被清空，
   * 只保留结构性信息（改了哪个文件、跑了几秒、成功与否）。
   * UI 必须把这类条目标成"锁定中，内容不可见"，而不是显示成空。
   */
  readonly redacted?: boolean
}

export type TraceItem =
  | (TraceBase & { readonly k: 'think'; readonly summary: string; readonly ms?: number })
  | (TraceBase & { readonly k: 'text'; readonly text: string; readonly streaming?: boolean })
  | (TraceBase & {
      readonly k: 'tool'
      readonly tool: string
      readonly target?: string
      /** 入参摘要（截断到 200 字符）。完整参数走 trace.detail 按需拉。 */
      readonly input?: string
      readonly output?: string
      readonly ms?: number
      readonly ok?: boolean
    })
  | (TraceBase & {
      readonly k: 'file'
      readonly path: string
      readonly op: 'add' | 'mod' | 'del' | 'rename'
      readonly additions?: number
      readonly deletions?: number
      readonly from?: string
    })
  | (TraceBase & {
      readonly k: 'term'
      readonly cmd: string
      readonly exit?: number
      /** 只保留尾部 N 行，完整输出走 trace.detail。 */
      readonly tail?: string
    })
  | (TraceBase & { readonly k: 'approval'; readonly id: string; readonly cmd: string; readonly risk?: string })
  | (TraceBase & {
      readonly k: 'question'
      readonly id: string
      readonly q: string
      readonly options: readonly string[]
      readonly multi: boolean
    })
  | (TraceBase & { readonly k: 'error'; readonly code: string; readonly msg: string })
  | (TraceBase & { readonly k: 'note'; readonly text: string })

/** trace 分页/续传参数。`since` 优于 `offset`：断线期间新增的条目不会漏。 */
export interface TraceCursor {
  readonly sessionId: string
  readonly since?: number
  readonly limit?: number
}

export interface TracePage {
  readonly items: readonly TraceItem[]
  /** 本次返回的最后一条 seq；下次用它做 since。 */
  readonly nextSeq: number
  /** 后面还有更早的历史（向上翻时用）。 */
  readonly hasMore: boolean
  /** 这一轮是否还在跑：true 时 App 应保持订阅。 */
  readonly running: boolean
}

/** trace 单条的完整内容（工具入参/终端全量输出）。默认不下发，点开才拉。 */
export interface TraceDetail {
  readonly seq: number
  readonly text: string
  readonly truncated: boolean
  readonly bytes: number
}

// ── 消息发送队列 ──────────────────────────────────────────────────────────

export type QueueItemState = 'pending' | 'sending' | 'sent' | 'failed' | 'canceled'

/**
 * 排队中的一条消息。
 *
 * 为什么需要显式的队列而不是"忙就报错"：
 * agent 跑一轮可能十几分钟，用户在这期间想到三件事是很正常的。
 * 报错会逼用户盯着进度条等，而人是先想后做的。
 */
export interface QueueItem {
  readonly id: string
  readonly sessionId: string
  readonly text: string
  readonly attachmentCount: number
  readonly createdAt: number
  readonly state: QueueItemState
  /** 排在第几位（0 起）；`sending` 时为 -1。 */
  readonly order: number
  readonly error?: string
}


// ── 文件 ──────────────────────────────────────────────────────────────────

export interface FileEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'file' | 'dir'
  readonly size: number
  readonly mtime: number
}

export interface UploadTarget {
  readonly workspaceId: string
  /** 相对工作区根的路径；空串表示根。宿主必须用它做路径约束。 */
  readonly dir: string
  readonly name: string
  readonly size: number
  /** 分块上传的会话 id，由宿主分配。 */
  readonly uploadId: string
}

/** 单文件元信息。看图/看代码前先拿它，决定走文本还是走二进制通道。 */
export interface FileStat {
  readonly path: string
  readonly kind: 'file' | 'dir'
  readonly size: number
  readonly mtime: number
  /** 粗判的 MIME，只用于选渲染器（代码/图片/markdown/未知）。 */
  readonly mime: string
  /** 含 NUL 前 8KiB 即判定二进制：界面不给"按文本打开"，避免一屏乱码。 */
  readonly binary: boolean
  /** 文本文件的行数；二进制为 0。 */
  readonly lines: number
  /** 是否是 git 仓库内的受版本控制文件（决定要不要显示"历史"入口）。 */
  readonly tracked: boolean
}

/**
 * 文件内容分片。**永远分页**：
 * 手机上一次性读 2MB 文本会直接卡死 WebView，而这个 App 的卖点之一就是"能看文件"。
 */
export interface FileSlice {
  readonly path: string
  readonly offset: number
  /** 文本时是原文，二进制时是 base64；由 `binary` 区分，不做双重编码。 */
  readonly content: string
  readonly bytes: number
  readonly total: number
  readonly eof: boolean
  readonly binary: boolean
}

/** 一处文件改动。会话产物、git 状态、diff 视图共用这一种形状。 */
export interface FileChange {
  readonly path: string
  readonly op: 'add' | 'mod' | 'del' | 'rename'
  readonly additions: number
  readonly deletions: number
  /** rename 的来源路径。 */
  readonly from?: string
  readonly binary?: boolean
}

// ── 仓库与 git ────────────────────────────────────────────────────────────

/**
 * 一个可浏览的仓库。
 *
 * `kind` 区分三种来源，因为它们的"能不能看历史"不一样：
 *   - workspace：工作区本身就是仓库（最常见）
 *   - nested   ：工作区里某个子目录是仓库（monorepo 常见）
 *   - github   ：没有本地 clone，走 GitHub API 只读浏览（需要 PC 侧 token）
 */
export interface RepoSummary {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly kind: 'workspace' | 'nested' | 'github'
  /** origin 的 URL；github 类型时是仓库全名 owner/repo。 */
  readonly remote?: string
  readonly provider?: 'github' | 'gitlab' | 'other'
  readonly branch?: string
  readonly head?: string
  readonly dirty?: boolean
  readonly ahead?: number
  readonly behind?: number
  /** 仓库内最近一次提交的时间，用于列表排序。 */
  readonly updatedAt: number
  readonly sessionId?: string
}

export interface GitStatus {
  readonly branch: string
  /** 短 hash。 */
  readonly head: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  /** 已暂存 / 未暂存分开给，因为界面上要分两组展示（合并会误导"改了但没加"）。 */
  readonly staged: readonly FileChange[]
  readonly unstaged: readonly FileChange[]
  readonly untracked: readonly string[]
  readonly conflicted: readonly string[]
}

export interface GitCommit {
  readonly hash: string
  readonly short: string
  readonly author: string
  readonly at: number
  readonly subject: string
  /** `HEAD -> main`、`tag: v1.2` 这类 ref 装饰。 */
  readonly refs?: readonly string[]
  readonly filesChanged?: number
}

export interface GitBranch {
  readonly name: string
  readonly current: boolean
  readonly remote: boolean
  readonly at: number
  readonly subject: string
}

export interface GitDiff {
  readonly path: string
  /** 统一 diff 文本。超过 `maxBytes` 会截断并置 `truncated`，绝不静默丢内容。 */
  readonly patch: string
  readonly additions: number
  readonly deletions: number
  readonly binary: boolean
  readonly truncated: boolean
  /** `new` = 新增文件，`deleted` = 已删除；revert 之类的动作据此决定可用性。 */
  readonly change: 'add' | 'mod' | 'del' | 'rename'
}

// ── 插件 ──────────────────────────────────────────────────────────────────

export interface PluginSummary {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly enabled: boolean
  readonly builtin: boolean
  /** 是否有 host 半 / client 半 / 是否声明了 dsh.bundle */
  readonly halves: { readonly host: boolean; readonly client: boolean; readonly bundle: boolean }
}

export interface PluginInspect {
  readonly name: string
  readonly version: string
  /** 将要写入的位置、依赖数、需要的权限线索。远程安装前必须展示。 */
  readonly installPath: string
  readonly dependencyCount: number
  readonly willRunPostinstall: boolean
  readonly dshRange?: string
}
