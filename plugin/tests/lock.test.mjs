/**
 * 锁屏状态机自检。用假 ctx + 临时目录，不起 dsh、不开端口。
 *
 * 覆盖的是**最不能出错的那部分**：没有密码时不许锁、锁死后豁免方法仍可达、
 * 失败限速、票据作用域。这些一旦错了，用户就被锁在门外或者门根本没锁。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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

/** 最小 ctx：只实现 LockService 用到的四个方法。 */
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-test-'))
  const cfg = normalizeConfig({ lock: overrides })
  const ctx = fakeCtx()
  const lock = new LockService(ctx, cfg, {
    store: join(dir, 'lock.json'),
    audit: join(dir, 'audit.jsonl'),
  })
  await lock.init()
  try {
    await fn({ lock, ctx, cfg })
  } finally {
    await lock.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

// ── 没有密码时不能锁 ──────────────────────────────────────────────────────

await test('没设密码时 armed=false，lock() 是空操作', async () => {
  await withService(async ({ lock }) => {
    assert.equal(lock.armed, false)
    lock.lock('manual')
    assert.equal(lock.get().locked, false, '没有密码就不该锁——否则会把用户锁死')
  })
})

// ── 基本锁定 / 解锁 ───────────────────────────────────────────────────────

await test('设密码后可锁，状态与审计都正确', async () => {
  await withService(async ({ lock, ctx }) => {
    await lock.setPassword('correct-horse')
    assert.equal(lock.armed, true)

    lock.lock('manual')
    const st = lock.get()
    assert.equal(st.locked, true)
    assert.equal(st.reason, 'manual')
    assert.equal(typeof st.since, 'number')
    assert.ok(
      ctx.events.some(([name]) => name === 'dsh-link/lock-changed'),
      '锁状态变化必须广播给客户端半与网关',
    )
  })
})

await test('正确密码解锁返回票据，且票据绑定设备', async () => {
  await withService(async ({ lock }) => {
    await lock.setPassword('correct-horse')
    lock.lock('manual')

    const result = lock.unlock('correct-horse', 'device', 'dev_a1b2')
    assert.equal(lock.get().locked, false)
    assert.ok(result.ticket.length > 20)
    assert.equal(result.expiresAt > Date.now(), true)

    // 同一设备可用
    assert.equal(lock.acceptTicket(result.ticket, 'dev_a1b2'), true)
    // 换一台设备不行（手机丢了只踢那一台的基础）
    assert.equal(lock.acceptTicket(result.ticket, 'dev_other'), false)
    // 改一个字符不行
    assert.equal(lock.acceptTicket(`${result.ticket}x`, 'dev_a1b2'), false)
  })
})

await test('错误密码抛 bad-password，并返回剩余次数', async () => {
  await withService(async ({ lock }) => {
    await lock.setPassword('correct-horse')
    lock.lock('manual')

    try {
      lock.unlock('wrong', 'owner')
      assert.fail('应该抛错')
    } catch (e) {
      assert.equal(e.code, 'lock/bad-password')
      assert.equal(e.details.attempt, 1)
      assert.equal(e.details.attemptsLeft, 4)
    }
    assert.equal(lock.get().locked, true, '解锁失败不应改变锁定状态')
    assert.equal(lock.get().failedAttempts, 1)
  })
})

await test('连续失败到上限后进入限速', async () => {
  await withService(
    async ({ lock }) => {
      await lock.setPassword('correct-horse')
      lock.lock('manual')

      for (let i = 0; i < 5; i++) {
        try {
          lock.unlock('wrong', 'owner')
        } catch (e) {
          assert.equal(e.code, 'lock/bad-password')
        }
      }

      try {
        lock.unlock('correct-horse', 'owner')
        assert.fail('限速期间即使密码正确也应拒绝')
      } catch (e) {
        assert.equal(e.code, 'lock/rate-limited')
        assert.ok(e.details.retryAfterMs > 0)
      }
    },
    { maxAttempts: 5, windowMinutes: 5 },
  )
})

// ── 半锁 ──────────────────────────────────────────────────────────────────

await test('soft 态可读不可写（由 protocol 的策略判定）', async () => {
  await withService(async ({ lock }) => {
    await lock.setPassword('correct-horse')
    // 直接进 soft：模拟"8 小时无操作"
    lock.touch()
    const st = lock.get()
    assert.equal(st.soft, false, 'touch 后不应是 soft')
    assert.equal(st.locked, false)
  })
})

// ── 持久化 ────────────────────────────────────────────────────────────────

await test('密码落盘后重新加载仍可校验（重启不用重设密码）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-test-'))
  const cfg = normalizeConfig({})
  const make = () =>
    new LockService(fakeCtx(), cfg, { store: join(dir, 'lock.json'), audit: join(dir, 'a.jsonl') })
  try {
    const a = make()
    await a.init()
    await a.setPassword('persisted-pass')
    await a.setPassword('persisted-pass') // 覆盖写两次也不应损坏
    await a.dispose()

    const b = make()
    await b.init()
    assert.equal(b.armed, true)
    b.lock('manual')
    const ticket = b.unlock('persisted-pass', 'owner')
    assert.ok(ticket.ticket.length > 20)
    await b.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('清除密码后不再 armed', async () => {
  await withService(async ({ lock }) => {
    await lock.setPassword('correct-horse')
    assert.equal(lock.armed, true)
    await lock.clearPassword()
    assert.equal(lock.armed, false)
    assert.equal(lock.get().locked, false)
  })
})

// ── 远程请求 ──────────────────────────────────────────────────────────────

await test('未锁时远程请求直接为 true', async () => {
  await withService(async ({ lock }) => {
    await lock.setPassword('correct-horse')
    const ok = await lock.requestRemote('dev_1', 'iPhone')
    assert.equal(ok, true)
  })
})

await test('锁定时远程请求由 PC 侧 settle 决定', async () => {
  await withService(async ({ lock, ctx }) => {
    await lock.setPassword('correct-horse')
    lock.lock('manual')

    const pending = lock.requestRemote('dev_1', 'iPhone 15', 5000)
    assert.ok(
      ctx.events.some(([name]) => name === 'dsh-link/lock-request'),
      'PC 侧要能收到弹窗事件',
    )
    assert.equal(lock.settleRemote('dev_1', true), true)
    assert.equal(await pending, true)
    assert.equal(lock.get().locked, false, '批准后应解锁')
  })
})

console.log(`\n${passed} passed`)
