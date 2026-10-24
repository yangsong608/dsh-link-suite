/**
 * 方法策略：角色 + 锁屏层级。
 *
 * **放在协议包里而不是插件里**，因为它同时是两份东西的数据源：
 *   - 宿主：router 用它做 guard（只有一处执行点）
 *   - App：用它提前禁用按钮（"这台机器锁着，安装按钮应该是灰的"）
 *
 * 如果放在宿主，App 就只能靠"发一次试试"来发现权限，体验会很糟：
 * 用户点了三次安装才被告知"主机已锁定"。
 */

import type { DeviceRole, LockState } from './types.js'
import type { Method } from './methods.js'
import { isLockExempt } from './methods.js'

/** 锁屏层级：`read` = 锁定态拒绝、半锁允许；`unlocked` = 两种锁态都拒绝。 */
export type LockTier = 'read' | 'unlocked'

export interface MethodPolicy {
  readonly role: DeviceRole
  readonly tier: LockTier
  /** 是否允许在没有活跃连接的情况下调用（只有 ping / 状态类可以）。 */
  readonly lockExempt: boolean
  /** 二进制帧上传的目标通道类型。 */
  readonly binary?: 'up'
}

/** 角色强度排序：用于 `hasRole` 的"至少达到"判断。 */
export const ROLE_RANK: Record<DeviceRole, number> = {
  viewer: 0,
  operator: 1,
  approver: 2,
  admin: 3,
}

export function hasRole(actual: DeviceRole, required: DeviceRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required]
}

const P = (role: DeviceRole, tier: LockTier = 'read', binary?: 'up'): MethodPolicy =>
  binary === undefined
    ? { role, tier, lockExempt: false }
    : { role, tier, lockExempt: false, binary }

const EXEMPT = (role: DeviceRole): MethodPolicy => ({ role, tier: 'read', lockExempt: true })

export const METHOD_POLICY: Record<Method, MethodPolicy> = {
  // 连接与设备
  'device.info': EXEMPT('viewer'),
  // 已配对设备都能看"我连的是哪台机器"——这不是管理操作，是基本的自我认知。
  // 只有撤销（踢掉别的设备）才需要 admin。
  'device.list': P('viewer'),
  'device.revoke': P('admin', 'unlocked'),
  // 改名不影响连接权限，操作级即可
  'device.rename': P('operator', 'unlocked'),
  // 配对**不是**豁免方法：锁定时允许配对，等于把门锁上却在锁上装了个新锁孔。
  // 人在电脑前才配对新设备，所以要求 unlocked 不会挡正常流程。
  'pair.start': P('viewer', 'unlocked'),
  'pair.finish': P('viewer', 'unlocked'),

  // 锁屏：三个豁免 + 一个需要已解锁
  'lock.status': EXEMPT('viewer'),
  'lock.unlock': EXEMPT('viewer'),
  'lock.request': EXEMPT('viewer'),
  'lock.lock': P('operator', 'read'),

  // 工作区
  'workspace.list': P('viewer'),
  'workspace.create': P('approver', 'unlocked'),
  'dir.list': P('operator'),

  // 会话
  'session.list': P('viewer'),
  // 创建会话会落盘（新建一个持久会话），视为写操作
  'session.create': P('operator', 'unlocked'),
  // 只读金额：不涉及会话内容，viewer 即可
  'cost.summary': P('viewer'),
  // 命令会改变会话状态（如进入 plan 模式），必须 operator + 解锁
  'session.command': P('operator', 'unlocked'),
  'session.plan': P('viewer'),
  'session.answer': P('operator', 'unlocked'),
  'session.prompt': P('operator', 'unlocked'),
  'session.cancel': P('operator', 'unlocked'),
  'session.follow': P('viewer'),
  'approval.answer': P('approver', 'unlocked'),

  // ── 执行过程 ────────────────────────────────────────────────────────
  // 一条贯穿全表的分级纪律：**看结构可以，看内容要解锁**。
  // 半锁（只读）时允许用户确认"机器还在干活、改了哪几个文件"，
  // 但不给代码正文——否则 fs.read 的限制会被 trace 里的 output 绕过去。
  'session.trace': P('viewer'),
  'session.trace.detail': P('viewer', 'unlocked'),

  // ── 消息队列 ────────────────────────────────────────────────────────
  // 队列是"将要执行的指令"，等同 session.prompt，一律 unlocked
  'session.queue.list': P('viewer'),
  'session.queue.push': P('operator', 'unlocked'),
  'session.queue.edit': P('operator', 'unlocked'),
  'session.queue.remove': P('operator', 'unlocked'),
  'session.queue.steer': P('operator', 'unlocked'),

  // ── 会话管理 ────────────────────────────────────────────────────────
  // 改名/归档都改动了会话的持久状态，等同写操作 → 需要解锁。
  // 读模型目录不改状态，与 session.list 同级
  'session.modelCatalog': P('viewer'),
  // 选模型会改变后续回合的行为，视为写操作
  'session.selectModel': P('operator', 'unlocked'),
  'session.rename': P('operator', 'unlocked'),
  'session.archive': P('operator', 'unlocked'),
  'session.unarchive': P('operator', 'unlocked'),

  // ── 会话产物 ────────────────────────────────────────────────────────
  'session.changes': P('viewer'),
  'session.diff': P('viewer', 'unlocked'),

  // ── 文件 ────────────────────────────────────────────────────────────
  'fs.list': P('viewer'),
  'fs.stat': P('viewer'),
  'fs.read': P('viewer', 'unlocked'),
  'fs.upload': P('operator', 'unlocked', 'up'),

  // ── 仓库与 git（全部只读，M2 不提供 commit/push）────────────────────
  'repo.list': P('viewer'),
  'repo.info': P('viewer'),
  'git.status': P('viewer'),
  'git.diff': P('viewer', 'unlocked'),
  'git.log': P('viewer'),
  'git.show': P('viewer', 'unlocked'),
  'git.branches': P('viewer'),

  // ── GitHub 远程仓库（M3，宿主侧持 token，绝不把 token 下发）──────────
  'repo.gh.tree': P('viewer', 'unlocked'),
  'repo.gh.file': P('viewer', 'unlocked'),

  // 插件
  'plugin.list': P('admin', 'unlocked'),
  'plugin.inspect': P('admin', 'unlocked'),
  'plugin.install': P('admin', 'unlocked'),
  'plugin.remove': P('admin', 'unlocked'),

  // 通道控制
  'chan.open': P('viewer'),
  'chan.close': P('viewer'),

  // 终端
  'term.create': P('admin', 'unlocked'),
}

/**
 * 给定锁状态与方法，返回拒绝原因；`undefined` 表示放行。
 *
 * 这是**纯函数**——宿主和 App 可以跑同一份逻辑，测试也不用起服务。
 * 宿主侧唯一调用点是 `packages/plugin/src/gateway/guard.ts`。
 */
export function lockRejection(
  lock: LockState,
  method: Method,
  policy: MethodPolicy = METHOD_POLICY[method],
): 'locked' | 'readonly' | undefined {
  if (policy.lockExempt || isLockExempt(method)) return undefined
  if (lock.locked) return 'locked'
  if (lock.soft && policy.tier === 'unlocked') return 'readonly'
  return undefined
}
