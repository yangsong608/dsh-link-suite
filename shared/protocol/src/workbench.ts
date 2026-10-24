/**
 * 工作台（dsh-workbench）协议形状：增量同步与几条写入。
 *
 * 为什么放在协议包里：`wb.delta.pull` 的 `changes` 会被 App 直接渲染，
 * 会被网关原样透传，也会被宿主写入。三处若各写一份形状，最早漂移的那份
 * 就是 bug 的来源。这里只定义**跨进程**的形状，宿主的表结构不进协议。
 *
 * 约定：
 *   - 时间是 ISO 8601 字符串（与宿主 /sync 接口一致），不是 epoch 毫秒
 *   - `entity` 是宿主的实体名（tasks / notes / news …），协议层不枚举，
 *     宿主新增实体时不需要改协议——这正是"缺项即不支持"的反面：
 *     这里用开放字符串，不用联合类型
 */

/** 一条变更的两种操作。`delete` 时 `row` 必然缺省。 */
export type WbOp = 'upsert' | 'delete'

/** 增量同步里的一条变更。`wb.delta.pull` 的响应与 `wb.delta.push` 的请求共用。 */
export interface WbChange {
  readonly entity: string
  readonly id: string
  readonly op: WbOp
  /**
   * 该行最后一次修改时间。宿主用**可字典序比较**的本地时间字符串
   * （`YYYY-MM-DD HH:MM:SS`），冲突判定与游标都是字符串比较。
   * 客户端只回传，不要自己换格式（换成 ISO 的 `T`/`Z` 会改变排序）。
   */
  readonly updatedAt: string
  /** `upsert` 时的行内容；`delete` 时不带。 */
  readonly row?: Record<string, unknown>
}

/** 单个实体的同步元信息（`wb.meta.get` 响应的 entities 值）。 */
export interface WbEntityStat {
  readonly count: number
  /** 该实体最新的 updatedAt；空表时为 null。 */
  readonly maxUpdatedAt: string | null
}

/** `wb.meta.get`：宿主各实体的条数与最新时间，App 用它决定"要不要拉增量"。 */
export interface WbMeta {
  readonly entities: Record<string, WbEntityStat>
}

/**
 * `wb.delta.pull` 的响应。
 *
 * `cursor` 是**不透明**值：原样回传给下一次 pull，不要自己拼时间——
 * 宿主的游标就是"本批最后一条的 updatedAt"，格式属于它的实现细节。
 */
export interface WbDelta {
  readonly cursor: string
  readonly changes: readonly WbChange[]
  readonly more: boolean
}

/** 变更的定位坐标。conflicts 用它指认"哪一条"。 */
export interface WbChangeRef {
  readonly entity: string
  readonly id: string
}

/** 宿主侧版本比客户端新：客户端必须用 `current` 覆盖本地行，而不是重推。 */
export interface WbPushConflict extends WbChangeRef {
  readonly current: Record<string, unknown> | null
}

/** `wb.delta.push` 的响应。冲突不是错误：一次 push 可以部分成功。 */
export interface WbPushResult {
  /**
   * 被接受的变更 **id**（宿主只回 id 数组，不回 entity——要定位请看 conflicts）。
   * 一次 push 混多个实体时，id 不保证跨实体唯一，这是宿主的既有契约。
   */
  readonly accepted: readonly string[]
  readonly conflicts: readonly WbPushConflict[]
}

/** `wb.focus.add` 的参数：记一次专注。 */
export interface WbFocusInput {
  readonly taskId: string
  readonly minutes: number
  readonly completed: boolean
}

/**
 * `wb.focus.add` 的响应。
 *
 * 专注记录走宿主的增量同步（focus_sessions 是一个同步实体），
 * 所以 id/startedAt 由网关生成，`accepted`/`conflicts` 来自那一次 push。
 */
export interface WbFocusResult {
  readonly id: string
  readonly startedAt: string
  readonly accepted: boolean
  readonly conflicts: readonly WbPushConflict[]
}

/**
 * `wb.news.fetchNow` 的响应。
 *
 * 当前版本是占位实现（宿主还没有"立即抓取"的入口），固定返回
 * `{queued:false, reason:'not-implemented'}`。形状先定下来，
 * App 可以照常展示"暂不支持"，将来宿主实现后只换实现不换协议。
 */
export interface WbNewsFetchResult {
  readonly queued: boolean
  readonly reason?: string
}
