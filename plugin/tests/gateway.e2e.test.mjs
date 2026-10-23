/**
 * 网关端到端自检：真的起一个 WS 服务、真的连、真的走配对与 RPC。
 *
 * 为什么必须有这个文件：前面 73 项测试全是"零件"，没有一项启动过服务。
 * 而这一轮改动（noServer 握手、令牌认证、三道闸门）恰恰只在真实连接下
 * 才会暴露问题——比如"拒绝后 ws 仍完成握手"这种，纯函数测试看不见。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { default as WebSocket } from 'ws'

import { startGateway } from '../lib/gateway/server.js'
import { createHandlers } from '../lib/gateway/router.js'
import { DeviceRegistry } from '../lib/gateway/devices.js'
import { LockService } from '../lib/lock/index.js'
import { normalizeConfig } from '../lib/config.js'
import { encodeFrame, decodeFrame } from '@dsh-link/protocol'

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} }

function fakeCtx() {
  const store = new Map()
  return {
    get: (n, strict) => { if (strict !== false) throw new Error('must soft-read'); return store.get(n) },
    set: (n, v) => store.set(n, v),
    effect: () => () => {},
    on: () => () => {},
    emit: () => {},
    logger: noopLogger,
  }
}

/** 起一套真实的网关（锁 + 设备表 + 路由），返回连接句柄。 */
async function harness(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-e2e-'))
  const ctx = fakeCtx()
  // 锁默认关闭；e2e 需要锁定场景时显式打开
  const cfg = normalizeConfig({ gateway: { bind: 'loopback', port: 0, ...overrides }, lock: { enabled: true } })
  const lock = new LockService(ctx, cfg, { store: join(dir, 'lock.json'), audit: join(dir, 'a.jsonl') })
  await lock.init()
  const devices = new DeviceRegistry(join(dir, 'devices.json'))
  await devices.load()

  let gateway
  const rc = {
    ctx, cfg, lock, devices,
    hostId: 'h_e2e_test_host',
    dshVersion: '0.0.0-test',
    // pair.start 会用 endpoints 生成候选地址与二维码。
    // 少了它，handler 里 endpoints.map 会抛 host/internal——
    // 这正是"给 handler 加依赖必须同步更新所有构造点"的教训。
    endpoints: ['ws://127.0.0.1:7443/dshlink'],
    gateway: () => gateway,
  }
  gateway = await startGateway({
    rc,
    handlers: createHandlers(),
    port: 0,
    host: '127.0.0.1',
    heartbeatMs: 60_000,
  })

  return {
    dir, lock, devices, gateway, cfg, ctx,
    url: (token) => `ws://127.0.0.1:${gateway.port}/dshlink${token ? `?token=${token}` : ''}`,
    async cleanup() {
      await gateway.close()
      await lock.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** 一个极简的客户端：发请求、等响应。 */
function client(url, opts = {}) {
  const ws = new WebSocket(url, opts)
  const pending = new Map()
  let nextId = 1
  const events = []

  ws.on('message', (raw) => {
    const frame = decodeFrame(raw.toString())
    if (frame.t === 'res') {
      const p = pending.get(frame.id)
      if (p === undefined) return
      pending.delete(frame.id)
      if (frame.ok) p.resolve(frame.r)
      else p.reject(Object.assign(new Error(frame.e.msg), { code: frame.e.code }))
      return
    }
    if (frame.t === 'evt') events.push(frame)
  })

  return {
    ws,
    events,
    ready: new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
      setTimeout(() => reject(new Error('连不上')), 3000)
    }),
    call(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(encodeFrame({ t: 'req', id, m: method, p: params }))
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} 超时`))
        }, 3000)
      })
    },
    close() { try { ws.close() } catch { /* 已断 */ } },
  }
}

await test('未认证连接可以调 device.info（预认证白名单生效）', async () => {
  const h = await harness()
  const c = client(h.url())
  try {
    await c.ready
    const info = await c.call('device.info')
    assert.equal(info.hostId, 'h_e2e_test_host')
    assert.ok(info.caps, 'device.info 要返回能力协商')
  } finally {
    c.close()
    await h.cleanup()
  }
})

await test('未认证连接调 session.list 被拒（auth/need-pair）', async () => {
  const h = await harness()
  const c = client(h.url())
  try {
    await c.ready
    await assert.rejects(() => c.call('session.list'), (e) => e.code === 'auth/need-pair')
  } finally {
    c.close()
    await h.cleanup()
  }
})

await test('完整配对：pair.start → PC 确认 → pair.finish → 拿到令牌', async () => {
  const h = await harness()
  const c = client(h.url())
  try {
    await c.ready
    const started = await c.call('pair.start')
    assert.match(started.code, /^\d{6}$/)
    // 手机自助发起的配对：未经 PC 确认，finish 必须被拒
    await assert.rejects(
      () => c.call('pair.finish', { code: started.code, label: 'iPhone', platform: 'ios' }),
      (e) => e.code === 'auth/forbidden',
      '未经确认的配对码不能完成配对',
    )
    // PC 侧确认（等价于点了「生成配对码」，因为 startPair(true) 会预批准；
    // 这里模拟 PC 的手动确认路径）
    assert.equal(h.devices.approvePair(started.code), true)

    const done = await c.call('pair.finish', { code: started.code, label: 'iPhone', platform: 'ios' })
    assert.ok(done.deviceId.startsWith('dev_'))
    assert.ok(done.token.length >= 32)

    // 配对成功后同一条连接立刻可用
    await c.call('device.list')
  } finally {
    c.close()
    await h.cleanup()
  }
})

await test('带令牌重连：直接认证，不需再配对', async () => {
  const h = await harness()
  try {
    const first = client(h.url())
    await first.ready
    const started = await first.call('pair.start')
    h.devices.approvePair(started.code)
    const { token } = await first.call('pair.finish', { code: started.code, label: 'Mac', platform: 'darwin' })
    first.close()

    const second = client(h.url(token))
    await second.ready
    // 未认证连接调 device.list 会 auth/need-pair；能成功说明令牌生效
    const list = await second.call('device.list')
    assert.ok(Array.isArray(list.devices))
    second.close()
  } finally {
    await h.cleanup()
  }
})

await test('错误令牌不会放行', async () => {
  const h = await harness()
  const c = client(h.url('not-a-real-token'))
  try {
    await c.ready
    await assert.rejects(() => c.call('device.list'), (e) => e.code === 'auth/need-pair')
  } finally {
    c.close()
    await h.cleanup()
  }
})

await test('跨站 Origin 在握手阶段被拒（连接建立不了）', async () => {
  const h = await harness()
  try {
    const ws = new WebSocket(h.url(), { headers: { origin: 'https://evil.example' } })
    const outcome = await new Promise((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('error', (e) => resolve('rejected: ' + e.message.slice(0, 30)))
      setTimeout(() => resolve('timeout'), 2000)
    })
    assert.match(String(outcome), /rejected/, '跨站来源绝不能被放行')
  } finally {
    await h.cleanup()
  }
})

await test('锁定态下 session.list 返回 lock/locked', async () => {
  const h = await harness()
  try {
    await h.lock.setPassword('correct-horse')
    const c = client(h.url())
    await c.ready
    const started = await c.call('pair.start')
    h.devices.approvePair(started.code)
    const { token } = await c.call('pair.finish', { code: started.code, label: 'X', platform: 'ios' })
    c.close()

    h.lock.lock('manual')

    const c2 = client(h.url(token))
    await c2.ready
    // 锁定态：非豁免方法一律 lock/locked
    await assert.rejects(() => c2.call('session.list'), (e) => e.code === 'lock/locked')
    // 豁免方法仍可达，否则永远解不开
    const status = await c2.call('lock.status')
    assert.equal(status.locked, true)
    c2.close()
  } finally {
    await h.cleanup()
  }
})

await test('撤销设备后令牌立即失效', async () => {
  const h = await harness()
  try {
    const c = client(h.url())
    await c.ready
    const started = await c.call('pair.start')
    h.devices.approvePair(started.code)
    const { deviceId, token } = await c.call('pair.finish', { code: started.code, label: 'Gone', platform: 'ios' })
    c.close()

    await h.devices.revoke(deviceId)

    const c2 = client(h.url(token))
    await c2.ready
    await assert.rejects(() => c2.call('device.list'), (e) => e.code === 'auth/need-pair')
    c2.close()
  } finally {
    await h.cleanup()
  }
})

await test('超大帧被拒（连接被关，1009）', async () => {
  const h = await harness()
  const c = client(h.url())
  try {
    await c.ready
    const closed = new Promise((resolve) => c.ws.on('close', (code) => resolve(code)))
    // 300KB > 256KiB 上限
    c.ws.send(encodeFrame({ t: 'req', id: 999, m: 'device.info', p: { pad: 'x'.repeat(300 * 1024) } }))
    const code = await closed
    assert.equal(code, 1009, '超限帧应以 1009 关闭')
  } finally {
    c.close()
    await h.cleanup()
  }
})


await test('本机回环即使不在白名单也必须放行（否则绑 0.0.0.0 后自己也连不上）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-lb-'))
  const ctx = fakeCtx()
  const cfg = normalizeConfig({ gateway: { bind: 'lan', port: 0 } })
  const lock = new LockService(ctx, cfg, { store: join(dir, 'l.json'), audit: join(dir, 'a.jsonl') })
  await lock.init()
  const devices = new DeviceRegistry(join(dir, 'd.json'))
  await devices.load()
  let gw
  const rc = { ctx, cfg, lock, devices, hostId: 'h_lb', dshVersion: 't', endpoints: [], gateway: () => gw }
  gw = await startGateway({
    rc, handlers: createHandlers(), port: 0, host: '0.0.0.0', heartbeatMs: 60_000,
    // 关键：白名单里**故意**不放 127.0.0.1
    allowedLocalAddresses: ['10.9.9.9'],
  })
  try {
    const c = client(`ws://127.0.0.1:${gw.port}/dshlink`)
    await c.ready
    const info = await c.call('device.info')
    assert.equal(info.hostId, 'h_lb', '回环连接必须成功')
    c.close()
  } finally {
    await gw.close()
    await lock.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

await test('pair.start 返回可用地址与二维码（App 靠它知道连哪里）', async () => {
  const h = await harness()
  const c = client(h.url())
  try {
    await c.ready
    const out = await c.call('pair.start')
    // 只回一个码是没用的：手机不知道宿主监听在哪
    assert.equal(typeof out.wsUrl, 'string', '必须给首选连接地址')
    assert.ok(Array.isArray(out.candidates) && out.candidates.length > 0, '必须有候选地址列表')
    assert.equal(out.candidates[0].wsUrl, out.wsUrl, '首选地址应与 candidates[0] 一致')
    // 二维码矩阵：前端靠着色，不需要引 QR 库
    assert.ok(out.qr && Number.isInteger(out.qr.size), '必须返回二维码矩阵')
    assert.equal(out.qr.modules.length, out.qr.size, '矩阵行数应等于 size')

    // 每个候选的 URI 都必须能被解析回同一个地址（PC 生成 / 手机解析是跨设备契约）
    const { decodePairUri } = await import('@dsh-link/protocol')
    for (const candidate of out.candidates) {
      const parsed = decodePairUri(candidate.uri)
      assert.equal(parsed.ok, true, `URI 应可解析：${candidate.uri}`)
      assert.equal(parsed.payload.code, out.code, '二维码里的码应与接口返回一致')
    }
  } finally {
    c.close()
    await h.cleanup()
  }
})

await test('未生成码时不会凭空给出地址（地址必须与码成对）', async () => {
  const h = await harness()
  try {
    // 直接调 handler，确认返回里的 code 与 wsUrl 同时存在
    const handlers = createHandlers()
    const rc = {
      ctx: h.ctx, cfg: h.cfg, lock: h.lock, devices: h.devices,
      hostId: 'h_pair', dshVersion: 't', endpoints: ['ws://10.0.0.9:7443/dshlink'],
      gateway: () => h.gateway,
    }
    const out = await handlers['pair.start'](rc, {}, {
      deviceId: 'unpaired', role: 'viewer', remoteAddress: '127.0.0.1', connId: 'c_x',
    })
    assert.match(out.code, /^\d{6}$/)
    assert.equal(out.wsUrl, 'ws://10.0.0.9:7443/dshlink')
    assert.equal(out.next, 'ask-owner', '手机自助配对必须等 PC 确认')
  } finally {
    await h.cleanup()
  }
})

console.log(`\n${passed} passed`)
