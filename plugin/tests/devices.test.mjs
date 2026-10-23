/**
 * 设备注册表与配对流程自检。
 *
 * 覆盖的是"配对到底能不能走通"这条链路：码的 TTL、PC 侧确认、
 * 令牌哈希落盘（不存明文）、撤销立即生效。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DeviceRegistry } from '../lib/gateway/devices.js'

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

async function withRegistry(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-dev-'))
  const registry = new DeviceRegistry(join(dir, 'devices.json'))
  await registry.load()
  try {
    await fn({ registry, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await test('配对码是 6 位数字，且有 TTL', async () => {
  await withRegistry(async ({ registry }) => {
    const session = registry.startPair(120_000)
    assert.match(session.code, /^\d{6}$/, '配对码必须是 6 位数字（手机上要手输）')
    assert.equal(session.approved, false)
    assert.ok(session.expiresAt > Date.now())
  })
})

await test('未在 PC 确认前 finish 被拒绝（not-approved）', async () => {
  await withRegistry(async ({ registry }) => {
    const session = registry.startPair()
    const outcome = await registry.finishPair({ code: session.code, label: 'iPhone', platform: 'ios' })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.reason, 'not-approved')
  })
})

await test('确认之后 finish 成功，返回设备与令牌', async () => {
  await withRegistry(async ({ registry }) => {
    const session = registry.startPair()
    assert.equal(registry.approvePair(session.code), true)
    const outcome = await registry.finishPair({ code: session.code, label: 'iPhone 15', platform: 'ios' })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.result.device.label, 'iPhone 15')
    assert.equal(outcome.result.device.role, 'operator', '默认角色是 operator（能发指令，不能装插件）')
    assert.ok(outcome.result.token.length >= 32)
    assert.equal(registry.list().length, 1)
  })
})

await test('令牌能认证，改一个字符即失效', async () => {
  await withRegistry(async ({ registry }) => {
    const session = registry.startPair()
    registry.approvePair(session.code)
    const outcome = await registry.finishPair({ code: session.code, label: 'iPad', platform: 'ios' })
    const token = outcome.result.token

    const record = registry.authenticate(token)
    assert.ok(record, '正确令牌必须能认证')
    assert.equal(record.label, 'iPad')

    // 失败一律返回 undefined（不区分"签名错"与"设备不存在"，少给攻击者信息）
    assert.equal(registry.authenticate(`${token}x`), undefined)
    assert.equal(registry.authenticate(''), undefined)
    assert.equal(registry.authenticate(undefined), undefined)
  })
})

await test('令牌只以 sha256 落盘，明文不出现在文件里', async () => {
  await withRegistry(async ({ registry, dir }) => {
    const session = registry.startPair()
    registry.approvePair(session.code)
    const outcome = await registry.finishPair({ code: session.code, label: 'Mac', platform: 'darwin' })
    const text = await readFile(join(dir, 'devices.json'), 'utf8')
    assert.equal(text.includes(outcome.result.token), false, '禁止把 bearer 令牌明文落盘')
    assert.match(text, /"tokenHash":\s*"[0-9a-f]{64}"/, '应当只存 sha256 十六进制')
    const st = await stat(join(dir, 'devices.json'))
    assert.equal(st.mode & 0o077, 0, 'devices.json 不能对 group/other 可读')
  })
})

await test('配对码只能消费一次（防重放）', async () => {
  await withRegistry(async ({ registry }) => {
    const session = registry.startPair()
    registry.approvePair(session.code)
    const first = await registry.finishPair({ code: session.code, label: 'A', platform: 'ios' })
    assert.equal(first.ok, true)
    const second = await registry.finishPair({ code: session.code, label: 'B', platform: 'ios' })
    assert.equal(second.ok, false)
    assert.ok(['consumed', 'unknown-code'].includes(second.reason))
    assert.equal(registry.list().length, 1, '不能因为重放多出一台设备')
  })
})

await test('过期的配对码不能确认、也不能 finish', async () => {
  await withRegistry(async ({ registry }) => {
    const session = registry.startPair(1) // 1ms 后过期
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(registry.approvePair(session.code), false)
    const outcome = await registry.finishPair({ code: session.code, label: 'X', platform: 'ios' })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.reason, 'expired')
  })
})

await test('撤销之后：列表看不到、令牌失效、记录留在文件里', async () => {
  await withRegistry(async ({ registry, dir }) => {
    const session = registry.startPair()
    registry.approvePair(session.code)
    const outcome = await registry.finishPair({ code: session.code, label: '旧手机', platform: 'android' })
    const { deviceId } = outcome.result.device
    const token = outcome.result.token

    assert.equal(await registry.revoke(deviceId), deviceId)
    assert.equal(registry.list().length, 0)
    assert.equal(registry.authenticate(token), undefined, '撤销后令牌必须立即失效')

    const text = await readFile(join(dir, 'devices.json'), 'utf8')
    assert.ok(text.includes(deviceId), '撤销记录要保留，便于审计')
    assert.ok(text.includes('revokedAt'))
  })
})

await test('撤销不存在的设备返回 undefined（而不是抛错）', async () => {
  await withRegistry(async ({ registry }) => {
    assert.equal(await registry.revoke('dev_nope'), undefined)
  })
})

await test('重启后设备表从文件恢复，令牌仍可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-dev-persist-'))
  try {
    const path = join(dir, 'devices.json')
    const a = new DeviceRegistry(path)
    await a.load()
    const session = a.startPair()
    a.approvePair(session.code)
    const outcome = await a.finishPair({ code: session.code, label: '持久化设备', platform: 'ios' })

    const b = new DeviceRegistry(path)
    await b.load()
    assert.equal(b.list().length, 1)
    assert.ok(b.authenticate(outcome.result.token), '重启后令牌必须仍能认证')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('pendingPairs 只返回未消费且未过期的码', async () => {
  await withRegistry(async ({ registry }) => {
    const s1 = registry.startPair(60_000)
    const s2 = registry.startPair(1)
    registry.approvePair(s1.code)
    await new Promise((r) => setTimeout(r, 5))
    const pending = registry.pendingPairs()
    assert.equal(pending.length, 1, '过期的码不应出现在待确认列表')
    assert.equal(pending[0].code, s1.code)
    assert.equal(pending[0].approved, true)
    assert.equal(pending.some((p) => p.code === s2.code), false)
  })
})

await test('标签为空时给一个明确默认值（UI 不能显示空白设备）', async () => {
  await withRegistry(async ({ registry }) => {
    const session = registry.startPair()
    registry.approvePair(session.code)
    const outcome = await registry.finishPair({ code: session.code, label: '   ', platform: 'ios' })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.result.device.label, '未命名设备')
  })
})

console.log(`\n${passed} passed`)
