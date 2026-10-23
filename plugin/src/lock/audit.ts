/**
 * 审计：追加写 JSONL，只追加不修改。
 *
 * 全生态都没有审计（见前序分析）。这里做最小集，但满足三条：
 *   1. 只记事件与必要参数，**永不记密码或票据**
 *   2. 0600 权限，只追加
 *   3. 不做轮转——一次锁屏约 120 字节，一年也就几十 KB
 */

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export type AuditEvent =
  | { ev: 'lock'; reason: string; idleMs?: number }
  | { ev: 'unlock.ok'; from: 'owner' | 'device'; deviceId?: string }
  | { ev: 'unlock.fail'; from: 'owner' | 'device'; attempt: number; deviceId?: string }
  | { ev: 'unlock.limited'; retryAfterMs: number }
  | { ev: 'remote.request'; deviceId: string; result: 'approved' | 'denied' | 'timeout' }
  | { ev: 'device.paired'; deviceId: string; label: string }
  | { ev: 'device.revoked'; deviceId: string }
  | { ev: 'plugin.install'; name: string; ok: boolean }
  /** 密码生命周期。只记事件，永不记密码本身或它的 hash。 */
  | { ev: 'password.set'; first: boolean }
  | { ev: 'password.clear' }
  /** 空闲判定落入软锁或硬锁时，记下当时的依据（有没有运行中的会话）。 */
  | { ev: 'lock.idle'; reason: 'idle'; running: number }

export interface AuditRecord extends Record<string, unknown> {
  t: string
  ev: string
}

export class AuditLog {
  readonly #file: string
  #queue: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.#file = file
  }

  /** 串行化写入：并发 append 在部分文件系统上会交错，日志就不能按行解析了。 */
  write(event: AuditEvent): void {
    const record: AuditRecord = { t: new Date().toISOString(), ...event }
    const line = `${JSON.stringify(record)}\n`
    this.#queue = this.#queue
      .then(async () => {
        await fs.mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
        await fs.appendFile(this.#file, line, { encoding: 'utf8', mode: 0o600 })
      })
      .catch(() => {
        // 审计失败不能影响主流程：锁能不能用，比日志全不全重要。
      })
  }

  /** 读最近 n 条（给设置页展示）。解析失败的行走跳过，不抛。 */
  async tail(n = 20): Promise<AuditRecord[]> {
    let text: string
    try {
      text = await fs.readFile(this.#file, 'utf8')
    } catch {
      return []
    }
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    return lines
      .slice(-n)
      .map((l) => {
        try {
          return JSON.parse(l) as AuditRecord
        } catch {
          return undefined
        }
      })
      .filter((x): x is AuditRecord => x !== undefined)
  }

  /** 测试与关闭时等待队列落盘。 */
  async flush(): Promise<void> {
    await this.#queue
  }
}
