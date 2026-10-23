/**
 * dsh / cordis 的最小类型面。
 *
 * 刻意**不**依赖 `@deepseek-ai/dsh-*` 与 `cordis` 的类型包：
 *   1. 这个插件要能独立编译（npm install 只装 typescript + @types/node）
 *   2. 依赖类型包会把版本锁死在某个 dsh 快照上，升级即红
 *
 * 代价是没有自动补全。所以这里的形状必须和官方文档一致，改动要有依据。
 */

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * cordis 4 的 Context。
 *
 * **铁律**：读取插件作用域里的服务必须走 `ctx.get(name, false)`。
 * 直接 `ctx.foo` 在严格代理下会抛 "cannot get property without inject"，
 * 即使该服务不存在也一样——所以不要写 `ctx.foo ?? fallback`，前半句就炸了。
 */
export interface DshContext {
  get<T = unknown>(name: string, strict?: boolean): T | undefined
  set(name: string, value: unknown): void
  effect(effect: () => void | (() => void), label?: string): void
  on(event: string, listener: (...args: never[]) => void): () => void
  emit(event: string, ...args: unknown[]): void
  logger?: Logger
}

/** dsh 的 theme 服务（用于把 550W 皮肤推给宿主界面）。 */
export interface ThemeService {
  overrideTokens(
    id: string,
    tokens: Record<string, { light: string; dark: string }>,
  ): () => void
}

/** dsh 的 webServer：只用来注册我们自己的前缀路由，不 patch 它的 server。 */
export interface WebServerService {
  readonly protocol: 'http:' | 'https:'
  getOrigin(): string
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }): () => void
}

/** 会话服务（只声明我们用到的部分）。 */
/**
 * 会话服务。
 *
 * 形状必须与宿主真实签名一致——这两条是实测出来的，不是猜的：
 *   - `list(request, signal)`：signal 是**必填**，缺了会在运行时抛
 *   - `follow(request, signal)`：返回 AsyncIterable，不是 Promise
 * 写错这里的代价是"类型全绿、运行时全红"，所以改之前先看
 * packages/api/session-controller/src/index.ts 的装饰器签名。
 */
export interface SessionController {
  list(request: { cursor?: string }, signal: AbortSignal): Promise<unknown>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  modelCatalog?(): Promise<unknown>
  /** 读投影（队列就在 values.inbox）。冷会话也能读，不需要唤醒 agent。 */
  projections?(request: { sessionId: string }): Promise<unknown>
  /** 修改队列项：edit / remove / steer。 */
  updateQueue?(request: {
    sessionId: string
    itemId: string
    action: { kind: 'edit'; content: { type: 'text'; text: string }[] } | { kind: 'remove' } | { kind: 'steer' }
  }): Promise<unknown>
  selectModel?(request: { sessionId: string; provider: string; model: string }): Promise<unknown>
  prompt(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  cancel(request: { sessionId: string }): Promise<unknown>
  follow(request: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown>
}

/** 工作区记录（只声明我们读到的字段）。 */
export interface HostWorkspace {
  readonly id: unknown
  readonly path: string
  readonly title: string
  readonly createdAt: string
  /** 该工作区包含的会话 id（权威归属来源）。 */
  readonly sessionIds?: readonly unknown[]
}

/** 工作区控制器（会话归档属于它，不在 sessionController 上）。 */
export interface WorkspaceController {
  archiveSession(request: { sessionId: string; stopRunning?: boolean }): Promise<unknown>
  unarchiveSession(request: { sessionId: string }): Promise<unknown>
}

export interface WorkspaceRegistry {
  list(): HostWorkspace[]
  get(id: unknown): HostWorkspace | undefined
  create(path: string, title?: string): Promise<HostWorkspace>
}

export interface PluginManager {
  listBundles(): Promise<unknown>
  inspect(spec: string): Promise<unknown>
  installBundle(spec: string, options?: unknown): Promise<unknown>
  removeBundle(name: string): Promise<unknown>
}
