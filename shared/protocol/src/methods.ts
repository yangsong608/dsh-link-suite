/**
 * DSH Link 协议版本与方法名。
 *
 * 方法名是**数据**而不是函数：宿主侧用它在 ROUTES 表里查策略（角色 / 锁屏层级），
 * 客户端用它在类型层获得提示。两侧共用一份，避免"客户端发了个宿主不认识的方法"。
 */

export const PROTOCOL_VERSION = 1

/** 能力协商：老版本 App 连新宿主不会炸，缺项即视为不支持。 */
export interface Caps {
  readonly fs: 1
  readonly plugins: 1
  readonly term: 0 | 1
  readonly appext: 1
  readonly lock: 1
  /** 执行过程流（`session.trace*`）。老宿主没有这一组，App 就不显示"执行详情"入口。 */
  readonly trace: 0 | 1
  /** 消息发送队列（`session.queue.*`）。为 0 时 App 退回"忙就提示"的老交互。 */
  readonly queue: 0 | 1
  /** git 只读浏览（`repo.*` / `git.*`）。为 0 时文件树隐藏 .git 相关入口。 */
  readonly git: 0 | 1
  /** GitHub 远程仓库浏览（需要 PC 侧 token）。默认关闭。 */
  readonly gh: 0 | 1
}

export const DEFAULT_CAPS: Caps = {
  fs: 1,
  plugins: 1,
  term: 0,
  appext: 1,
  lock: 1,
  trace: 1,
  queue: 1,
  git: 1,
  gh: 0,
}

/**
 * 全部方法名。新增方法必须同时：
 *   1. 在这里登记（App 侧才能类型安全地调用）
 *   2. 在 packages/plugin/src/gateway/router.ts 的 ROUTES 里给策略（否则运行时报 rpc/unknown）
 */
export const METHODS = [
  // 连接与设备
  'device.info',
  'device.list',
  'device.revoke',
  'device.rename',
  'pair.start',
  'pair.finish',

  // 锁屏（4 个豁免方法，锁死时也必须有前 3 个可达，否则无法解锁）
  'lock.status',
  'lock.unlock',
  'lock.request',
  'lock.lock',

  // 工作区
  'workspace.list',
  'workspace.create',
  'dir.list',

  // 会话
  'session.create',
  // 费用与峰谷（数据来自 dsh-cost-meter；宿主没装就返回 available:false）
  'cost.summary',
  // 执行斜杠命令（/plan、/compact 等由宿主命令注册表处理）
  'session.command',
  // 计划 / 待办步骤（宿主 plan 投影）
  'session.plan',
  // 回答宿主的提问（ask_user_question 等）
  'session.answer',
  'session.list',
  'session.prompt',
  'session.modelCatalog',
  'session.selectModel',
  'session.cancel',
  'session.follow',
  'approval.answer',

  // 执行过程（"它到底在干什么"）
  'session.trace',
  'session.trace.detail',

  // 消息发送队列（agent 跑着的时候也能继续说话）
  'session.queue.list',
  'session.queue.push',
  'session.queue.edit',
  'session.queue.remove',
  // dsh 的队列没有「重排」也没有「清空」：顺序就是数组下标，
  // 清空只能逐条 remove。这里只声明真实存在的能力。
  'session.queue.steer',

  // 会话产物（这一轮动了哪些文件）
  // 会话管理（改名 / 归档）。dsh 不提供物理删除会话，
  // 只有 archive（从列表移除但保留日志），这是它的设计选择——
  // 我们不发明一个"删除"去绕开它。
  'session.rename',
  'session.archive',
  'session.unarchive',

  'session.changes',
  'session.diff',

  // 文件（只读浏览）
  'fs.list',
  'fs.stat',
  'fs.read',
  'fs.upload',

  // 仓库与 git（只读）
  'repo.list',
  'repo.info',
  'git.status',
  'git.diff',
  'git.log',
  'git.show',
  'git.branches',

  // GitHub 远程仓库（M3，PC 侧持 token，默认关闭）
  'repo.gh.tree',
  'repo.gh.file',

  // 插件
  'plugin.list',
  'plugin.inspect',
  'plugin.install',
  'plugin.remove',

  // 通道控制（协议内部）
  'chan.open',
  'chan.close',

  // 终端（admin，默认关）
  'term.create',
] as const

export type Method = (typeof METHODS)[number]

const METHOD_SET: ReadonlySet<string> = new Set(METHODS)

export function isMethod(value: string): value is Method {
  return METHOD_SET.has(value)
}

/**
 * 锁定态下**仍然可达**的方法。
 *
 * 只有 4 个，且都只读或只作用于锁本身。任何新增都必须能被"锁死时也能调用"这句话解释，
 * 否则就是把锁撬开了一个洞。执行点在 gateway/guard.ts，这里是唯一的名单来源。
 */
export const LOCK_EXEMPT_METHODS: readonly Method[] = [
  'device.info',
  'lock.status',
  'lock.unlock',
  'lock.request',
]

export function isLockExempt(method: string): boolean {
  return LOCK_EXEMPT_METHODS.includes(method as Method)
}
