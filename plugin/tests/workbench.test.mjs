/**
 * 工作台适配层自检：`wb.*` ↔ dsh-workbench 的 `/workbench-api`。
 *
 * 为什么必须用本地桩件而不是 mock fetch：
 *   这一层的全部风险都在 HTTP 语义上——超时怎么表现、404 与 500 怎么区分、
 *   body 有没有真的透传。把 fetch 换掉等于把要验证的东西一起换掉了，
 *   所以这里起一个真的 http server，只把"工作台"换成桩。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { RpcError } from '@dsh-link/protocol'
import { createWorkbench } from '../lib/adapters/workbench.js'
import { createHandlers } from '../lib/gateway/router.js'

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/**
 * 起一个桩服务。`routes` 的键是 `METHOD /workbench-api/...`（不含查询串），
 * 值是 `(req, res, body) => void`。
 */
async function startStub(routes) {
  const seen = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub.local')
      const key = `${req.method ?? 'GET'} ${url.pathname}`
      let body
      try {
        body = raw.length === 0 ? undefined : JSON.parse(raw)
      } catch {
        body = raw
      }
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
      const handler = routes[key]
      if (handler === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not_found' }))
        return
      }
      handler(req, res, body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      }),
  }
}

const json = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const expectRpc = async (promise, code, pattern) => {
  let caught
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof RpcError, `应抛 RpcError，实际是 ${String(caught)}`)
  assert.equal(caught.code, code, `错误码应为 ${code}，实际 ${caught.code}（${caught.message}）`)
  if (pattern !== undefined) assert.match(caught.message, pattern)
  return caught
}

const change = (id) => ({
  entity: 'tasks',
  id,
  op: 'upsert',
  updatedAt: '2026-10-24T12:00:00.000Z',
  row: { id, title: '把 P1-2 做完' },
})

// ── 成功路径 ──────────────────────────────────────────────────────────────

await test('meta：GET /workbench-api/sync/meta 并透传 entities', async () => {
  const stub = await startStub({
    'GET /workbench-api/sync/meta': (_req, res) =>
      json(res, 200, { entities: { tasks: { count: 3, maxUpdatedAt: '2026-10-24T12:00:00.000Z' } } }),
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base })
    const meta = await wb.meta(undefined)
    assert.equal(meta.entities.tasks.count, 3)
    assert.equal(stub.seen.length, 1)
    assert.equal(stub.seen[0].method, 'GET')
    assert.equal(stub.seen[0].path, '/workbench-api/sync/meta')
  } finally {
    await stub.close()
  }
})

await test('delta：since/entity/limit 拼进查询串并返回 changes', async () => {
  const stub = await startStub({
    'GET /workbench-api/sync/delta': (_req, res) =>
      json(res, 200, { cursor: 'c1', changes: [change('t1')], more: false }),
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base })
    const delta = await wb.delta(undefined, {
      since: '2026-10-23T00:00:00.000Z',
      entity: 'tasks',
      limit: 20,
    })
    assert.equal(delta.cursor, 'c1')
    assert.equal(delta.changes.length, 1)
    assert.equal(delta.more, false)
    const q = stub.seen[0].query
    assert.equal(q.since, '2026-10-23T00:00:00.000Z')
    assert.equal(q.entity, 'tasks')
    assert.equal(q.limit, '20')
  } finally {
    await stub.close()
  }
})

await test('delta：可选参数缺省时查询串干净（不出现 since=undefined）', async () => {
  const stub = await startStub({
    'GET /workbench-api/sync/delta': (_req, res) => json(res, 200, { cursor: '', changes: [], more: false }),
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base })
    await wb.delta(undefined, { entity: '', limit: undefined })
    assert.deepEqual(stub.seen[0].query, {})
  } finally {
    await stub.close()
  }
})

await test('push：body 原样透传 {changes}，并带回 accepted(ids)/conflicts', async () => {
  const stub = await startStub({
    'POST /workbench-api/sync/push': (_req, res, body) =>
      json(res, 200, {
        accepted: body.changes.map((c) => c.id),
        conflicts: [],
      }),
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base })
    const input = [change('t1'), change('t2')]
    const result = await wb.push(undefined, input)
    assert.deepEqual(stub.seen[0].body, { changes: input })
    assert.deepEqual(result.accepted, ['t1', 't2'])
    assert.deepEqual(result.conflicts, [])
  } finally {
    await stub.close()
  }
})

await test('state：代理 GET /state（只读，不解析成业务类型）', async () => {
  const stub = await startStub({
    'GET /workbench-api/state': (_req, res) => json(res, 200, { revision: 7, spaces: [], tasks: [] }),
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base })
    const state = await wb.state(undefined)
    assert.equal(state.revision, 7)
    assert.equal(stub.seen[0].path, '/workbench-api/state')
  } finally {
    await stub.close()
  }
})

await test('notes.put / notes.delete：POST /notes、DELETE /notes/:id（id 会转义）', async () => {
  const stub = await startStub({
    'POST /workbench-api/notes': (_req, res, body) => json(res, 200, { ok: true, note: body.note }),
    'DELETE /workbench-api/notes/n%2F1': (_req, res) => json(res, 200, { ok: true }),
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base })
    const note = { id: 'n/1', title: '周报' }
    const put = await wb.notesPut(undefined, note)
    assert.deepEqual(put.note, note)
    assert.deepEqual(stub.seen[0].body, { note })
    await wb.notesDelete(undefined, 'n/1')
    assert.equal(stub.seen[1].method, 'DELETE')
    assert.equal(stub.seen[1].path, '/workbench-api/notes/n%2F1')
  } finally {
    await stub.close()
  }
})

await test('focus.add：推一条 focus_sessions upsert（宿主没有 /focus 路由）', async () => {
  const stub = await startStub({
    'POST /workbench-api/sync/push': (_req, res, body) =>
      json(res, 200, { accepted: body.changes.map((c) => c.id), conflicts: [] }),
    'GET /workbench-api/news': (_req, res) => json(res, 200, { topics: [], items: [] }),
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base })
    const result = await wb.focusAdd(undefined, { taskId: 't1', minutes: 25, completed: true })
    assert.equal(result.accepted, true)
    assert.deepEqual(result.conflicts, [])
    assert.match(result.id, /^f_/)
    // 时间戳必须是宿主那套「YYYY-MM-DD HH:MM:SS」：LWW 与游标都按字符串比较，
    // 换成 ISO 的 T/Z 会被判成永远最新（真实踩过的坑）。
    assert.match(result.startedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    const seen = stub.seen[0]
    assert.equal(seen.method, 'POST')
    assert.equal(seen.path, '/workbench-api/sync/push')
    const [pushed] = seen.body.changes
    assert.equal(pushed.entity, 'focus_sessions')
    assert.equal(pushed.id, result.id)
    assert.equal(pushed.op, 'upsert')
    assert.equal(pushed.updatedAt, result.startedAt)
    assert.deepEqual(pushed.row, {
      id: result.id,
      taskId: 't1',
      startedAt: result.startedAt,
      minutes: 25,
      completed: true,
    })

    const news = await wb.newsList(undefined)
    assert.deepEqual(news, { topics: [], items: [] })
  } finally {
    await stub.close()
  }
})

// ── 失败映射：客户端据此决定"重试"还是"这机器没有工作台" ────────────────

await test('超时 → host/unavailable（5s 默认值之外用短超时验证）', async () => {
  const stub = await startStub({
    'GET /workbench-api/sync/meta': () => {
      // 故意不回：由客户端超时打断
    },
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base, timeoutMs: 120 })
    await expectRpc(wb.meta(undefined), 'host/unavailable', /超时/)
  } finally {
    await stub.close()
  }
})

await test('连接被拒（宿主没起）→ host/unavailable', async () => {
  const stub = await startStub({})
  const base = stub.base
  await stub.close()
  const wb = createWorkbench({ origin: () => base, timeoutMs: 500 })
  await expectRpc(wb.meta(undefined), 'host/unavailable', /连不上/)
})

await test('取不到 webServer → 所有方法 host/unavailable，不抛原生错误', async () => {
  const wb = createWorkbench({ origin: () => undefined })
  for (const call of [
    () => wb.meta(undefined),
    () => wb.delta(undefined, {}),
    () => wb.push(undefined, [change('t1')]),
    () => wb.state(undefined),
    () => wb.notesPut(undefined, { id: 'n1' }),
    () => wb.notesDelete(undefined, 'n1'),
    () => wb.focusAdd(undefined, { taskId: 't1', minutes: 1, completed: false }),
    () => wb.newsList(undefined),
  ]) {
    await expectRpc(call(), 'host/unavailable', /webServer/)
  }
})

await test('404 / 501 / 503 → host/unavailable（工作台未安装）', async () => {
  const stub = await startStub({
    'GET /workbench-api/sync/meta': (_req, res) => json(res, 501, { error: 'not_implemented' }),
    'GET /workbench-api/sync/delta': (_req, res) => json(res, 503, { error: 'busy' }),
    // /state 故意不登记：桩件回 404（模拟宿主没有这条路由）
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base })
    await expectRpc(wb.meta(undefined), 'host/unavailable', /HTTP 501/)
    await expectRpc(wb.delta(undefined, {}), 'host/unavailable', /HTTP 503/)
    await expectRpc(wb.state(undefined), 'host/unavailable', /HTTP 404/)
  } finally {
    await stub.close()
  }
})

await test('400 / 500 → host/internal（宿主自己出错，带状态码与服务端消息）', async () => {
  const stub = await startStub({
    'POST /workbench-api/sync/push': (_req, res) => json(res, 500, { error: 'sync_broken', message: '数据库锁了' }),
    'POST /workbench-api/notes': (_req, res) => json(res, 400, { error: 'bad_request' }),
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base })
    const pushErr = await expectRpc(wb.push(undefined, [change('t1')]), 'host/internal', /HTTP 500/)
    assert.match(pushErr.message, /数据库锁了/)
    assert.equal(pushErr.details.status, 500)
    await expectRpc(wb.notesPut(undefined, { id: 'n1' }), 'host/internal', /HTTP 400/)
  } finally {
    await stub.close()
  }
})

await test('2xx 但不是 JSON → host/internal（不把坏数据当成功）', async () => {
  const stub = await startStub({
    'GET /workbench-api/sync/meta': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>proxy error</html>')
    },
    'GET /workbench-api/sync/delta': (_req, res) => json(res, 200, { cursor: 'c' }),
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base })
    await expectRpc(wb.meta(undefined), 'host/internal', /不是 JSON/)
    // 形状不对（缺 changes）也要报错，而不是把 undefined 传给 App
    await expectRpc(wb.delta(undefined, {}), 'host/internal', /changes/)
  } finally {
    await stub.close()
  }
})

// ── 探测与 caps ──────────────────────────────────────────────────────────

await test('probe：可达返回 true，并在 TTL 内复用（不重复打 HTTP）', async () => {
  const stub = await startStub({
    'GET /workbench-api/sync/meta': (_req, res) => json(res, 200, { entities: {} }),
  })
  try {
    const wb = createWorkbench({ origin: () => stub.base })
    assert.equal(await wb.probe(undefined), true)
    assert.equal(await wb.probe(undefined), true)
    assert.equal(stub.seen.length, 1, 'TTL 内第二次探测应命中缓存')
  } finally {
    await stub.close()
  }
})

await test('probe：不可达 / 未安装一律 false，绝不抛错', async () => {
  const missing = await startStub({})
  try {
    const wb = createWorkbench({ origin: () => missing.base })
    assert.equal(await wb.probe(undefined), false)
  } finally {
    await missing.close()
  }
  const offline = await startStub({})
  const base = offline.base
  await offline.close()
  assert.equal(await createWorkbench({ origin: () => base, timeoutMs: 200 }).probe(undefined), false)
  assert.equal(await createWorkbench({ origin: () => undefined }).probe(undefined), false)
})

await test('device.info：caps.workbench 按探测结果给 1 / 0', async () => {
  const stub = await startStub({
    'GET /workbench-api/sync/meta': (_req, res) => json(res, 200, { entities: {} }),
  })
  try {
    const rcWith = (webServer) => ({
      ctx: { get: (name) => (name === 'webServer' ? webServer : undefined), logger: { info() {}, warn() {} } },
      cfg: { gateway: { bind: 'loopback' }, repo: { github: { enabled: false } } },
      lock: { get: () => ({ locked: false, soft: false }) },
      devices: {},
      hostId: 'h',
      dshVersion: 't',
      gateway: () => undefined,
      endpoints: [],
    })

    const handlers = createHandlers()
    const up = await handlers['device.info'](rcWith({ getOrigin: () => stub.base }), {}, { connId: 'c' })
    assert.equal(up.caps.workbench, 1)
    // 其余 caps 不能被顺带改坏
    assert.equal(up.caps.git, 1)
    assert.equal(up.caps.gh, 0)

    const down = await handlers['device.info'](rcWith(undefined), {}, { connId: 'c' })
    assert.equal(down.caps.workbench, 0, '没有 webServer 时必须宣称不支持')
  } finally {
    await stub.close()
  }
})

// ── 网关层参数校验（错误在网关就被拦住，不打到宿主）─────────────────────

await test('wb.delta.push：非法 changes 报 rpc/bad-args，不发 HTTP', async () => {
  const stub = await startStub({})
  try {
    const handlers = createHandlers()
    const rc = {
      ctx: {
        get: (name) => (name === 'webServer' ? { getOrigin: () => stub.base } : undefined),
        logger: { info() {}, warn() {} },
      },
      cfg: { gateway: { bind: 'loopback' }, repo: { github: { enabled: false } } },
      lock: { get: () => ({ locked: false, soft: false }) },
      devices: {},
      hostId: 'h',
      dshVersion: 't',
      gateway: () => undefined,
      endpoints: [],
    }
    const cases = [
      {},
      { changes: 'nope' },
      { changes: [{ entity: 'tasks', id: '', op: 'upsert', updatedAt: 'x' }] },
      { changes: [{ entity: 'tasks', id: 't1', op: 'merge', updatedAt: 'x' }] },
      { changes: [{ entity: 'tasks', id: 't1', op: 'delete' }] },
    ]
    for (const params of cases) {
      await expectRpc(handlers['wb.delta.push'](rc, params, { connId: 'c' }), 'rpc/bad-args')
    }
    assert.equal(stub.seen.length, 0, '参数不合法时不该发请求')
  } finally {
    await stub.close()
  }
})

await test('wb.news.fetchNow：占位实现返回 not-implemented（不碰 HTTP）', async () => {
  const out = await createHandlers()['wb.news.fetchNow']({}, {}, { connId: 'c' })
  assert.deepEqual(out, { queued: false, reason: 'not-implemented' })
})

console.log(`\n${passed} passed`)
