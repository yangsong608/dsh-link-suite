/**
 * prompt 的附件契约。
 *
 * App 端选完文件后是"图片内联 / 文件用 receiptId"两条路，这里锁住
 * 宿主确实把它们拼进了 content——不然界面显示"已附加"，宿主却只收到文字。
 */
import assert from 'node:assert/strict'
import { createHandlers } from '../lib/gateway/router.js'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log('  ok  ' + name) }

/** 造一个只记录 prompt 入参的假会话服务。 */
function fakeSessions() {
  const seen = []
  return {
    seen,
    service: {
      prompt: async (request) => { seen.push(request); return { accepted: true } },
      cancel: async () => ({ accepted: true }),
      list: async () => ({ items: [] }),
      follow: async function* () {},
      updateQueue: async () => ({ accepted: true }),
      projections: async () => ({ values: { inbox: {} } }),
    },
  }
}

const rcOf = (sessions) => ({
  ctx: { get: (n) => (n === 'sessionController' ? sessions : undefined), logger: { info() {}, warn() {} } },
  cfg: {}, lock: { touch() {}, get: () => ({ locked: false, soft: false }) }, devices: {},
  hostId: 'h', dshVersion: 't', gateway: () => undefined, endpoints: [],
})

await test('纯文字：content 只有 text 块', async () => {
  const { seen, service } = fakeSessions()
  await createHandlers()['session.prompt'](rcOf(service), { sessionId: 's1', text: 'hi', requestId: 'r1' }, { connId: 'c' })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].content, [{ type: 'text', text: 'hi' }])
})

await test('带附件：文件追加 file 块（receiptId）', async () => {
  const { seen, service } = fakeSessions()
  await createHandlers()['session.prompt'](
    rcOf(service),
    { sessionId: 's1', text: '看下这个', requestId: 'r2', attachments: ['rcpt_a', 'rcpt_b'] },
    { connId: 'c' },
  )
  const content = seen[0].content
  assert.equal(content.length, 3)
  assert.deepEqual(content[1], { type: 'file', receiptId: 'rcpt_a' })
  assert.deepEqual(content[2], { type: 'file', receiptId: 'rcpt_b' })
})

await test('带图片：内联 image 块（mediaType + base64）', async () => {
  const { seen, service } = fakeSessions()
  await createHandlers()['session.prompt'](
    rcOf(service),
    { sessionId: 's1', text: '', requestId: 'r3', images: [{ mediaType: 'image/png', data: 'AAA' }] },
    { connId: 'c' },
  )
  const content = seen[0].content
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].mediaType, 'image/png')
  assert.equal(content[1].data, 'AAA')
})

await test('空附件数组不影响（不能塞空 file 块）', async () => {
  const { seen, service } = fakeSessions()
  await createHandlers()['session.prompt'](
    rcOf(service),
    { sessionId: 's1', text: 'x', requestId: 'r4', attachments: [], images: [] },
    { connId: 'c' },
  )
  assert.equal(seen[0].content.length, 1)
})

await test('队列 push 也带附件', async () => {
  const { seen, service } = fakeSessions()
  await createHandlers()['session.queue.push'](
    rcOf(service),
    { sessionId: 's1', text: '排队发', requestId: 'r5', attachments: ['rcpt_q'] },
    { connId: 'c' },
  )
  assert.equal(seen[0].mode, 'queue')
  assert.deepEqual(seen[0].content[1], { type: 'file', receiptId: 'rcpt_q' })
})

console.log(`\n${passed} passed`)
