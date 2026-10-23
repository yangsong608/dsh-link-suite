/**
 * 密码生命周期自检：设置 / 变更 / 清除 / 弱口令 / 限速 / 审计。
 *
 * 为什么单独一组：这些是"锁屏到底能不能用"的开关。原来的实现里
 * `setPassword()` 只有测试在调，没有任何真实入口，于是锁屏从装上那刻起
 * 就是未武装状态——功能等于不存在。这组测试锁住的是"入口存在且行为正确"。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LockService } from '../lib/lock/index.js'
import { normalizeConfig } from '../lib/config.js'

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} }

function fakeCtx() {
  const events = []
  const store = new Map()
  return {
    events,
    get: (name, strict) => {
      if (strict !== false) throw new Error(`fake ctx: 请用 get(${name}, false)`)
      return store.get(name)
    },
    set: (name, v) => store.set(name, v),
    effect: () => () => {},
    on: () => () => {},
    emit: (name, payload) => events.push([name, payload]),
    logger: noopLogger,
  }
}

async function withService(fn, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-pw-'))
  const cfg = normalizeConfig({ lock: overrides })
  const ctx = fakeCtx()
  const lock = new LockService(ctx, cfg, {
    store: join(dir, 'lock.json'),
    audit: join(dir, 'audit.jsonl'),
  })
  await lock.init()
  try {
    await fn({ lock, ctx, dir })
  } finally {
    await lock.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

await test('首次设置密码后 armed 变真，并写审计 password.set(first=true)', async () => {
  await withService(async ({ lock, dir }) => {
    assert.equal(lock.armed, false)
    await lock.setPassword('first-password')
    assert.equal(lock.armed, true)
    // 审计是串行异步 append，读之前必须等队列落盘
    await lock.dispose()
    const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    const records = audit.trim().split('\n').map((l) => JSON.parse(l))
    const set = records.find((r) => r.ev === 'password.set')
    assert.ok(set, '必须留下 password.set 审计')
    assert.equal(set.first, true)
    // 审计里绝不能出现密码本身
    assert.equal(audit.includes('first-password'), false)
  })
})

await test('设置密码会广播 lock-changed（客户端半不必等轮询）', async () => {
  await withService(async ({ lock, ctx }) => {
    await lock.setPassword('broadcast-me')
    const changes = ctx.events.filter(([name]) => name === 'dsh-link/lock-changed')
    assert.ok(changes.length >= 1, '设置密码后必须推送一次状态')
  })
})

await test('变更密码：当前密码错则拒绝，且不改任何状态', async () => {
  await withService(async ({ lock }) => {
    await lock.setPassword('original-pass')
    await assert.rejects(
      () => lock.changePassword('wrong-pass', 'another-pass'),
      (e) => e.code === 'lock/bad-password',
    )
    // 一次失败后原密码仍然有效（限速窗口是 5 次，这里只错 1 次）
    await assert.rejects(
      () => lock.changePassword('another-pass', 'third-password'),
      (e) => e.code === 'lock/bad-password',
      '错误的新密码不能生效',
    )
    // 原密码仍能改成功（说明前两次失败没有污染状态）
    await lock.changePassword('original-pass', 'another-pass')
    // 改成功之后，旧密码失效、新密码可用
    await assert.rejects(
      () => lock.changePassword('original-pass', 'x-password'),
      (e) => e.code === 'lock/bad-password',
      '旧密码必须已经失效',
    )
  })
})

await test('变更密码：成功后旧密码立即失效、新密码可用', async () => {
  await withService(async ({ lock }) => {
    await lock.setPassword('original-pass')
    await lock.changePassword('original-pass', 'replaced-pass')
    lock.lock('manual')
    // unlock 是同步方法：同步抛错要用 assert.throws，assert.rejects 只接 Promise
    assert.throws(
      () => lock.unlock('original-pass', 'owner'),
      (e) => e.code === 'lock/bad-password',
    )
    assert.ok(lock.unlock('replaced-pass', 'owner').ticket.length > 20)
  })
})

await test('变更密码：没有密码时明确报 no-password-set', async () => {
  await withService(async ({ lock }) => {
    await assert.rejects(
      () => lock.changePassword('whatever', 'whatever-else'),
      (e) => e.code === 'lock/no-password-set',
    )
  })
})

await test('清除密码：解除武装并写审计，锁状态回到未锁', async () => {
  await withService(async ({ lock, dir }) => {
    await lock.setPassword('to-be-cleared')
    lock.lock('manual')
    await lock.clearPassword()
    assert.equal(lock.armed, false)
    assert.equal(lock.get().locked, false)
    await lock.dispose()
    const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    assert.ok(audit.includes('"password.clear"'))
  })
})

await test('弱口令在 hashPassword 层就被拒绝（少于 6 位）', async () => {
  await withService(async ({ lock }) => {
    await assert.rejects(() => lock.setPassword('123'), /at least 6 characters/)
    assert.equal(lock.armed, false)
  })
})

await test('变更密码同样受滑动窗口限速保护（不能靠改密码绕过尝试次数）', async () => {
  await withService(
    async ({ lock }) => {
      await lock.setPassword('original-pass')
      for (let i = 0; i < 5; i++) {
        try {
          await lock.changePassword('bad-guess', 'new-password')
        } catch (e) {
          assert.equal(e.code, 'lock/bad-password')
        }
      }
      await assert.rejects(
        () => lock.changePassword('original-pass', 'new-password'),
        (e) => e.code === 'lock/rate-limited',
      )
    },
    { maxAttempts: 5, windowMinutes: 5 },
  )
})

await test('锁定态下改密码不会顺手解锁（改密码 ≠ 解锁）', async () => {
  await withService(async ({ lock }) => {
    await lock.setPassword('original-pass')
    lock.lock('manual')
    assert.equal(lock.get().locked, true)
    await lock.changePassword('original-pass', 'second-password')
    assert.equal(lock.get().locked, true, '改密码不应改变锁定状态')
  })
})

await test('密码落盘权限是 0600', async () => {
  await withService(async ({ lock, dir }) => {
    await lock.setPassword('perm-check')
    const { stat } = await import('node:fs/promises')
    const st = await stat(join(dir, 'lock.json'))
    // 0o600 & 0o777 = 384；Windows 上可能不同，这里只断言不是 644（世界可读）
    assert.equal(st.mode & 0o077, 0, 'lock.json 不能对 group/other 可读')
  })
})

console.log(`\n${passed} passed`)
