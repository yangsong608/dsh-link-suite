/**
 * session.create 的契约。
 *
 * 两条容易搞错的地方，用测试锁住：
 *   1. workspaceId 与 cwd 必须给一个（dsh 里二者互斥，都不给就没落点）
 *   2. 宿主返回的 sessionId 才是权威（可能复用了空白会话，与请求不同）
 */
import assert from 'node:assert/strict'
import { createHandlers } from '../lib/gateway/router.js'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log('  ok  ' + name) }

const rcOf = (sessions) => ({
  ctx: { get: (n) => (n === 'sessionController' ? sessions : undefined), logger: { info() {}, warn() {} } },
  cfg: {}, lock: { touch() {}, get: () => ({ locked: false, soft: false }) }, devices: {},
  hostId: 'h', dshVersion: 't', gateway: () => undefined, endpoints: [],
})

await test('按工作区新建：把 workspaceId 透传给宿主', async () => {
  const seen = []
  const service = { create: async (req) => { seen.push(req); return { sessionId: 'session-new' } } }
  const out = await createHandlers()['session.create'](rcOf(service), { workspaceId: 'ws_a' }, { connId: 'c' })
  assert.deepEqual(seen[0], { workspaceId: 'ws_a' })
  assert.equal(out.sessionId, 'session-new')
})

await test('按目录新建：cwd 透传', async () => {
  const seen = []
  const service = { create: async (req) => { seen.push(req); return { sessionId: 'session-cwd' } } }
  await createHandlers()['session.create'](rcOf(service), { cwd: '/work/x' }, { connId: 'c' })
  assert.deepEqual(seen[0], { cwd: '/work/x' })
})

await test('工作区与目录都不给 → bad-args（没有落点）', async () => {
  const service = { create: async () => ({ sessionId: 'x' }) }
  await assert.rejects(
    () => createHandlers()['session.create'](rcOf(service), {}, { connId: 'c' }),
    /工作区或目录/,
  )
})

await test('宿主返回的 id 是权威（可能复用了空白会话）', async () => {
  const service = { create: async () => ({ sessionId: 'session-reused' }) }
  const out = await createHandlers()['session.create'](rcOf(service), { workspaceId: 'ws_a' }, { connId: 'c' })
  assert.equal(out.sessionId, 'session-reused')
})

await test('宿主没返回 id → host/internal（不能把空串当会话）', async () => {
  const service = { create: async () => ({}) }
  await assert.rejects(
    () => createHandlers()['session.create'](rcOf(service), { workspaceId: 'ws_a' }, { connId: 'c' }),
    /没有返回会话 id/,
  )
})

await test('宿主没有 create 能力 → host/unavailable', async () => {
  await assert.rejects(
    () => createHandlers()['session.create'](rcOf({}), { workspaceId: 'ws_a' }, { connId: 'c' }),
    /不支持新建会话/,
  )
})

console.log(`\n${passed} passed`)
