/**
 * 协议自检。零测试框架：`npm test` = tsc 构建 + node 跑本文件。
 *
 * 只测**纯函数**：帧编解码、序号、锁屏拒绝判定、策略完整性。
 * 需要 IO 或 dsh 服务的东西不在这一层测。
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_CAPS,
  METHODS,
  METHOD_POLICY,
  UNLOCKED,
  buildNonce,
  decodeBinary,
  decodeFrame,
  encodeFileChunk,
  encodeFrame,
  encodeTermChunk,
  isLockExempt,
  lockRejection,
  SeqCounter,
  shouldDeliver,
} from '../dist/index.js'

let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

// ── 控制帧往返 ────────────────────────────────────────────────────────────

test('req 往返', () => {
  const f = { t: 'req', id: 17, m: 'session.prompt', p: { sessionId: 's_1' } }
  assert.deepEqual(decodeFrame(encodeFrame(f)), f)
})

test('res 成功与失败都能往返', () => {
  const ok = { t: 'res', id: 1, ok: true, r: { n: 1 } }
  const err = { t: 'res', id: 2, ok: false, e: { code: 'lock/locked', msg: 'locked' } }
  assert.deepEqual(decodeFrame(encodeFrame(ok)), ok)
  assert.deepEqual(decodeFrame(encodeFrame(err)), err)
})

test('evt 往返（含 seq）', () => {
  const f = { t: 'evt', ch: 'sess:s_1', seq: 8842, m: 'session.delta', p: { text: 'hi' } }
  assert.deepEqual(decodeFrame(encodeFrame(f)), f)
})

test('坏帧一律抛，不返回半成品', () => {
  assert.throws(() => decodeFrame('not json'))
  assert.throws(() => decodeFrame('{}'))
  assert.throws(() => decodeFrame(JSON.stringify({ t: 'weird' })))
  assert.throws(() => decodeFrame(JSON.stringify({ t: 'req', id: 'x', m: 'a' })))
})

// ── 二进制帧往返 ──────────────────────────────────────────────────────────

test('文件块往返', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5])
  const back = decodeBinary(encodeFileChunk({ kind: 'file', chId: 7, offset: 1_048_576, payload }))
  assert.equal(back.kind, 'file')
  assert.equal(back.chId, 7)
  assert.equal(back.offset, 1_048_576)
  assert.deepEqual([...back.payload], [...payload])
})

test('终端块往返', () => {
  const payload = new TextEncoder().encode('ls\n')
  const back = decodeBinary(encodeTermChunk({ kind: 'term', chId: 2, payload }))
  assert.equal(back.kind, 'term')
  assert.equal(back.chId, 2)
  assert.equal(new TextDecoder().decode(back.payload), 'ls\n')
})

test('未知二进制类别抛错', () => {
  assert.throws(() => decodeBinary(new Uint8Array([0x09, 0, 0, 0, 1])))
  assert.throws(() => decodeBinary(new Uint8Array([1])))
})

// ── 序号 ──────────────────────────────────────────────────────────────────

test('序号单调递增，reset 只能前进', () => {
  const c = new SeqCounter()
  assert.equal(c.next(), 0)
  assert.equal(c.next(), 1)
  c.reset(10)
  assert.equal(c.next(), 10)
  c.reset(3)
  assert.equal(c.next(), 11)
})

test('重复序号不投递', () => {
  assert.equal(shouldDeliver(5, 4), true)
  assert.equal(shouldDeliver(4, 4), false)
  assert.equal(shouldDeliver(3, 4), false)
})

// ── nonce ─────────────────────────────────────────────────────────────────

test('nonce 布局正确', () => {
  const n = buildNonce(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]), 258n)
  assert.equal(n.byteLength, 12)
  assert.deepEqual([...n.subarray(0, 4)], [0xaa, 0xbb, 0xcc, 0xdd])
  assert.deepEqual([...n.subarray(4)], [0, 0, 0, 0, 0, 0, 1, 2])
})

test('nonce 前缀长度不对要抛', () => {
  assert.throws(() => buildNonce(new Uint8Array(3), 0n))
})

// ── 锁屏策略 ──────────────────────────────────────────────────────────────

const LOCKED = { locked: true, soft: false, since: 1, reason: 'idle', failedAttempts: 0 }
const SOFT = { locked: false, soft: true, since: 1, reason: 'idle', failedAttempts: 0 }

test('解锁方法在锁死时仍可达（否则永远解不开）', () => {
  for (const m of ['lock.status', 'lock.unlock', 'lock.request', 'device.info']) {
    assert.equal(lockRejection(LOCKED, m), undefined, `${m} 应该豁免`)
    assert.equal(isLockExempt(m), true)
  }
})

test('锁死时读写都被拒', () => {
  assert.equal(lockRejection(LOCKED, 'session.prompt'), 'locked')
  assert.equal(lockRejection(LOCKED, 'session.list'), 'locked')
  assert.equal(lockRejection(LOCKED, 'plugin.install'), 'locked')
})

test('半锁（soft）时只读放行、写拒绝', () => {
  assert.equal(lockRejection(SOFT, 'session.list'), undefined)
  assert.equal(lockRejection(SOFT, 'fs.list'), undefined)
  assert.equal(lockRejection(SOFT, 'session.prompt'), 'readonly')
  assert.equal(lockRejection(SOFT, 'fs.upload'), 'readonly')
  assert.equal(lockRejection(SOFT, 'plugin.install'), 'readonly')
})

test('未锁时一切放行', () => {
  for (const m of METHODS) assert.equal(lockRejection(UNLOCKED, m), undefined, m)
})

test('每个方法都有策略（新增方法忘了配会在这里挂）', () => {
  for (const m of METHODS) {
    assert.ok(METHOD_POLICY[m], `缺少策略：${m}`)
    assert.ok(METHOD_POLICY[m].role, `缺少角色：${m}`)
  }
})

test('豁免名单与策略表一致（两处不能漂移）', () => {
  for (const m of METHODS) {
    assert.equal(METHOD_POLICY[m].lockExempt, isLockExempt(m), `${m} 的 lockExempt 不一致`)
  }
})

// ── 新增能力的策略纪律 ────────────────────────────────────────────────────
//
// 这几条把"看结构可以，看内容要解锁"这句设计约束钉死。
// 没有它们，将来某次改动把 fs.read 改成 'read' 也没人会发现。

test('半锁：文件树、执行过程、git 状态可看', () => {
  for (const m of ['fs.list', 'fs.stat', 'session.trace', 'session.changes', 'repo.list', 'git.status', 'git.log', 'git.branches']) {
    assert.equal(lockRejection(SOFT, m), undefined, `${m} 在半锁时应放行`)
  }
})

test('半锁：内容类一律拒绝（否则 fs.read 的拦截会被 trace 绕过）', () => {
  for (const m of ['fs.read', 'session.diff', 'git.diff', 'git.show', 'session.trace.detail', 'repo.gh.tree', 'repo.gh.file']) {
    assert.equal(lockRejection(SOFT, m), 'readonly', `${m} 在半锁时应拒绝`)
  }
})

test('锁死时队列与文件浏览全拒（只剩 4 个豁免方法）', () => {
  for (const m of ['session.queue.list', 'session.queue.push', 'fs.list', 'git.status', 'session.trace']) {
    assert.equal(lockRejection(LOCKED, m), 'locked', `${m} 在锁死时应拒绝`)
  }
})

test('队列写操作与 session.prompt 同层级（不能出现"能排队但不能发言"）', () => {
  assert.equal(METHOD_POLICY['session.prompt'].tier, 'unlocked')
  // dsh 的队列没有 reorder / clear，这里只校验真实存在的方法
  for (const m of ['session.queue.push', 'session.queue.edit', 'session.queue.remove', 'session.queue.steer']) {
    assert.equal(METHOD_POLICY[m].tier, 'unlocked', `${m} 的 tier 应与 session.prompt 一致`)
    assert.equal(METHOD_POLICY[m].role, 'operator', `${m} 的 role 应与 session.prompt 一致`)
  }
})

test('git 浏览全部是只读角色（M2 不提供 commit/push）', () => {
  for (const m of ['repo.list', 'repo.info', 'git.status', 'git.diff', 'git.log', 'git.show', 'git.branches']) {
    assert.equal(METHOD_POLICY[m].role, 'viewer', `${m} 不该要求更高角色：它是只读的`)
  }
})

test('默认能力协商开启 trace/queue/git，关闭 GitHub', () => {
  assert.equal(DEFAULT_CAPS.trace, 1)
  assert.equal(DEFAULT_CAPS.queue, 1)
  assert.equal(DEFAULT_CAPS.git, 1)
  assert.equal(DEFAULT_CAPS.gh, 0, 'GitHub 浏览需要 token，必须显式开启')
})

test('新增方法总数与分组自检（防止只加名字不加策略之外还漏了别的）', () => {
  assert.equal(METHODS.length, new Set(METHODS).size, '方法名有重复')
  assert.ok(METHODS.length >= 46, `方法数偏少：${METHODS.length}`)
})

console.log(`\n${passed} passed`)
