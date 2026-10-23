/**
 * 变更重建的测试。
 *
 * 这些用例锁住的是"诚实"：只重建能重建的，缺的东西要能被识别出来，
 * 而不是凭空补一个看起来完整的清单。
 */
import assert from 'node:assert/strict'
import { buildChanges, latestDiffForPath, diffLines, extractDiffRecords } from '../lib/adapters/changes.js'

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed += 1
  console.log('  ok  ' + name)
}

/** 造一条 tool/result 事件（write/edit 会带 meta.diffs）。 */
const toolResult = (diffs) => ({
  type: 'event',
  event: { type: 'tool/result', seq: 1, time: 1, data: { message: { content: [] }, meta: { diffs } } },
})

await test('从 tool/result 的 meta.diffs 提取记录', () => {
  const records = extractDiffRecords([
    toolResult([{ path: 'a.ts', oldText: 'x', newText: 'y' }]),
  ])
  assert.equal(records.length, 1)
  assert.equal(records[0].path, 'a.ts')
  assert.equal(records[0].before, 'x')
  assert.equal(records[0].after, 'y')
})

await test('不认识的形状安静跳过（dsh 加新事件不能让我们报错）', () => {
  const events = [
    { type: 'event', event: { type: 'tool/result', data: {} } },
    { type: 'event', event: { type: 'tool/result', data: { meta: {} } } },
    { type: 'event', event: { type: 'tool/result', data: { meta: { diffs: 'nope' } } } },
    { type: 'event', event: { type: 'assistant/message', data: { text: 'hi' } } },
    { type: 'event', event: { type: 'tool/result', data: { meta: { diffs: [{}] } } } },
  ]
  assert.deepEqual(extractDiffRecords(events), [])
})

await test('新文件判定为 add（before 为空）', () => {
  const [f] = buildChanges([toolResult([{ path: 'new.ts', oldText: '', newText: 'a\nb' }])])
  assert.equal(f.op, 'add')
  assert.equal(f.additions, 2)
  assert.equal(f.deletions, 0)
})

await test('删除判定为 del（after 为空）', () => {
  const [f] = buildChanges([toolResult([{ path: 'old.ts', oldText: 'a\nb\nc', newText: '' }])])
  assert.equal(f.op, 'del')
  assert.equal(f.deletions, 3)
})

await test('同一文件多次改动以最后一次为准（用户只关心最终结果）', () => {
  const files = buildChanges([
    toolResult([{ path: 'a.ts', oldText: 'v1', newText: 'v2' }]),
    toolResult([{ path: 'a.ts', oldText: 'v2', newText: 'v3' }]),
  ])
  assert.equal(files.length, 1, '同一路径只出现一次')
  const diff = latestDiffForPath([
    toolResult([{ path: 'a.ts', oldText: 'v1', newText: 'v2' }]),
    toolResult([{ path: 'a.ts', oldText: 'v2', newText: 'v3' }]),
  ], 'a.ts')
  assert.equal(diff.before, 'v2')
  assert.equal(diff.after, 'v3')
})

await test('按改动量排序（大的在前）', () => {
  const files = buildChanges([
    toolResult([
      { path: 'small.ts', oldText: 'a', newText: 'b' },
      { path: 'big.ts', oldText: 'a\nb\nc\nd', newText: '' },
    ]),
  ])
  assert.equal(files[0].path, 'big.ts')
})

await test('diffLines：新文件全是 +，删除文件全是 -', () => {
  const add = diffLines('', 'a\nb')
  assert.deepEqual(add.map((l) => l.t), ['+', '+'])
  const del = diffLines('a\nb', '')
  assert.deepEqual(del.map((l) => l.t), ['-', '-'])
})

await test('diffLines：公共前缀保留为上下文，中间变更成对出现', () => {
  const out = diffLines('a\nb\nc', 'a\nB\nc')
  assert.equal(out[0].t, ' ')
  assert.ok(out.some((l) => l.t === '-' && l.s === 'b'))
  assert.ok(out.some((l) => l.t === '+' && l.s === 'B'))
  assert.equal(out[out.length - 1].t, ' ')
})

await test('大文件被截断（手机端不需要全文）', () => {
  const big = 'x\n'.repeat(30_000)
  const diff = latestDiffForPath([toolResult([{ path: 'big.txt', oldText: '', newText: big }])], 'big.txt')
  assert.ok(diff.after.length <= 20_000, 'after 截断到 2 万字符')
  assert.ok(diff.hunks.length <= 400, 'hunks 截断到 400 行')
})

await test('找不到路径时返回 undefined（调用方给明确错误）', () => {
  assert.equal(latestDiffForPath([], 'nope.ts'), undefined)
})

console.log(`\n${passed} passed`)
