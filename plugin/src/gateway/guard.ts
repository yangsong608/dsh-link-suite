/**
 * 锁屏的唯一执行点。
 *
 * 为什么单独一个文件、只有十几行：
 * 因为"每个 handler 里写一句 if (locked)"是这类插件最经典的漏洞来源——
 * 漏一个方法就是一个洞，而且没人会发现。
 *
 * 策略数据在 `@dsh-link/protocol` 的 METHOD_POLICY 里（App 端也要用同一份），
 * 这里只负责"判定 + 抛错"。
 */

import { lockRejection, RpcError, type LockState, type Method } from '@dsh-link/protocol'

export function guardLock(lock: LockState, method: Method): void {
  const verdict = lockRejection(lock, method)
  if (verdict === undefined) return

  if (verdict === 'locked') {
    throw new RpcError('lock/locked', '主机已锁定', {
      since: lock.since,
      reason: lock.reason,
      // App 用它决定"是显示解锁按钮还是显示倒计时"
      attemptsLeft: lock.attemptsLeft,
    })
  }

  throw new RpcError('lock/readonly', '主机处于只读状态，请先解锁', {
    since: lock.since,
  })
}
