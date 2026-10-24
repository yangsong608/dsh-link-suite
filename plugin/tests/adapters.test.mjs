/**
 * 适配层自检：会话事件 → TraceItem / StreamItem，以及会话摘要映射。
 *
 * 这些是纯函数，脱开宿主就能测——这正是把它们从 handler 里抽出来的原因。
 * 重点覆盖"未知事件不能抛错"：dsh 加事件类型比我们跟得快，抛错会让整条流断掉。
 */

import assert from 'node:assert/strict'

import {
  sessionStatus,
  sessionTitle,
  toSessionSummaries,
  toSessionSummary,
  toStreamItem,
  toTraceItem,
} from '../lib/adapters/sessions.js'

let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

// ── 会话摘要 ──────────────────────────────────────────────────────────────

test('running 优先于一切（正在跑就是 running）', () => {
  assert.equal(sessionStatus({ sessionId: 's', updatedAt: 1, running: true, blank: true }), 'running')
})

test('空白会话是 idle，有内容且不在跑是 done', () => {
  assert.equal(sessionStatus({ sessionId: 's', updatedAt: 1, running: false, blank: true }), 'idle')
  assert.equal(sessionStatus({ sessionId: 's', updatedAt: 1, running: false, blank: false }), 'done')
})

test('标题优先取 projections.title', () => {
  assert.equal(
    sessionTitle({ sessionId: 's', updatedAt: 1, running: false, blank: false, cwd: '/a/b', projections: { title: '修 bug' } }),
    '修 bug',
  )
})

test('没有 title 时退化成 cwd 尾段', () => {
  assert.equal(
    sessionTitle({ sessionId: 's', updatedAt: 1, running: false, blank: false, cwd: '/Users/x/projects/demo' }),
    'demo',
  )
})

test('既没有 title 也没有 cwd 时给明确默认值', () => {
  assert.equal(sessionTitle({ sessionId: 's', updatedAt: 1, running: false, blank: true }), '未命名会话')
})

test('列表按 updatedAt 倒序，并过滤掉没有 id 的脏数据', () => {
  const items = toSessionSummaries(
    [
      { sessionId: 'old', updatedAt: 100, running: false, blank: false },
      { sessionId: 'new', updatedAt: 300, running: true, blank: false },
      { sessionId: '', updatedAt: 999, running: false, blank: false },
      { updatedAt: 500, running: false, blank: false },
    ],
    'ws_1',
  )
  assert.deepEqual(items.map((i) => i.id), ['new', 'old'])
  assert.equal(items[0].workspaceId, 'ws_1')
  assert.equal(items[0].status, 'running')
})

// ── 事件 → TraceItem ──────────────────────────────────────────────────────

test('assistant/message → text（读 message.content[]）', () => {
  const item = toTraceItem({
    type: 'assistant/message', seq: 3, at: 10,
    data: { message: { content: [{ type: 'text', text: '你好' }] } },
  })
  assert.equal(item.k, 'text')
  assert.equal(item.text, '你好')
  assert.equal(item.seq, 3)
})

test('assistant/message 缺 text 时丢弃（不产出空气泡）', () => {
  assert.equal(toTraceItem({ type: 'assistant/message', seq: 3, data: {} }), undefined)
})

test('tool/call 用真实字段 name/arguments（dsh 的 SessionEventMap）', () => {
  // 关键：字段名是 name / arguments，不是 toolName / input。
  // 取错字段会落到兜底 'tool'，界面上就是一串看不懂的 "▸ tool"。
  const long = JSON.stringify({ command: 'x'.repeat(500) })
  const item = toTraceItem({ type: 'tool/call', seq: 4, data: { name: 'Bash', arguments: long } })
  assert.equal(item.k, 'tool')
  assert.equal(item.tool, 'Bash', '必须取到真实工具名')
  // 上限从 200 提到 4000：todo_write / ask_user_question 的完整 JSON
  // 必须完整到达客户端，否则清单与选项永远解析不出来
  // 200 字符的限制会让 todo_write / ask_user_question 的 JSON 被截断，
  // 客户端永远解析不出清单与选项。现在上限 4000，短参数原样保留。
  assert.ok(item.input.length > 200, 'input 不再截到 200')
})

test('tool/call 从 arguments 解析出可读目标', () => {
  const bash = toTraceItem({
    type: 'tool/call', seq: 5,
    data: { name: 'Bash', arguments: JSON.stringify({ command: 'npm test' }) },
  })
  assert.equal(bash.target, 'npm test', '命令取 command 字段')

  const read = toTraceItem({
    type: 'tool/call', seq: 6,
    data: { name: 'Read', arguments: JSON.stringify({ file_path: '/a/b.ts' }) },
  })
  assert.equal(read.target, '/a/b.ts', '文件取 file_path')

  // 非 JSON 参数：取第一行
  const raw = toTraceItem({ type: 'tool/call', seq: 7, data: { name: 'Bash', arguments: 'ls -la' } })
  assert.equal(raw.target, 'ls -la')
})

test('tool 调用带 callId（用于合并 result）', () => {
  const item = toTraceItem({
    type: 'tool/call', seq: 8,
    data: { name: 'Bash', arguments: '{}', callId: 'call_1' },
  })
  assert.equal(item.callId, 'call_1')
})

test('tool/result 用真实结构 message/error 判断成败', () => {
  const ok = toTraceItem({
    type: 'tool/result', seq: 5,
    data: { callId: 'c1', message: { content: [{ type: 'text', text: 'all good' }] } },
  })
  assert.equal(ok.k, 'tool')
  assert.equal(ok.ok, true, '没有 error 字段 = 成功')
  assert.equal(ok.output, 'all good')
  assert.equal(ok.callId, 'c1')

  const bad = toTraceItem({
    type: 'tool/result', seq: 6,
    data: { callId: 'c2', message: { content: [] }, error: { name: 'E', code: 'E1', reason: 'boom' } },
  })
  assert.equal(bad.ok, false, '有 error 字段 = 失败')
})

test('approval/asked → approval，带 id 与命令', () => {
  const item = toTraceItem({ type: 'approval/asked', seq: 6, data: { id: 'a1', toolName: 'Bash', reason: '写文件' } })
  assert.equal(item.k, 'approval')
  assert.equal(item.id, 'a1')
  assert.equal(item.cmd, 'Bash')
  assert.equal(item.risk, '写文件')
})

test('turn/start 与 turn/end 用 note 表达（TraceKind 里没有 done）', () => {
  const start = toTraceItem({ type: 'turn/start', seq: 7 })
  const end = toTraceItem({ type: 'turn/end', seq: 8, data: { ok: true } })
  assert.equal(start.k, 'note')
  assert.equal(end.k, 'note')
  assert.equal(end.text, '本轮结束')
})

test('error → error，带 code 与 msg', () => {
  const item = toTraceItem({ type: 'error', seq: 9, data: { code: 'fs/escape', message: '越界' } })
  assert.equal(item.k, 'error')
  assert.equal(item.code, 'fs/escape')
  assert.equal(item.msg, '越界')
})

test('未知事件静默丢弃，绝不抛错（dsh 加事件比我们跟得快）', () => {
  assert.equal(toTraceItem({ type: 'brand/new-event', seq: 10, data: {} }), undefined)
  assert.equal(toTraceItem({ type: 'tool/call' }), undefined, '缺 seq 也要丢弃')
})

test('redacted 时清空正文，但保留结构（半锁只看"改了什么"）', () => {
  const item = toTraceItem(
    { type: 'tool/result', seq: 11, data: { name: 'Bash', message: { content: [{ type: 'text', text: '敏感内容' }] } } },
    true,
  )
  assert.equal(item.k, 'tool')
  assert.equal(item.redacted, true)
  assert.equal(item.output, undefined)
  assert.equal(item.ok, true)
  // tool/result 本身不带工具名（dsh 的结构里没有 name 字段），
  // 合并时由上层保留 call 那条的名字，所以这里允许为空

})

// ── TraceItem → StreamItem ────────────────────────────────────────────────

test('text → assist 气泡', () => {
  const stream = toStreamItem({ k: 'text', seq: 1, at: 5, text: 'hi' })
  assert.equal(stream.k, 'assist')
  assert.equal(stream.text, 'hi')
})

test('tool → activity（聊天页只显示一行"在干什么"）', () => {
  const stream = toStreamItem({ k: 'tool', seq: 2, at: 5, tool: 'Bash', target: 'npm test', ok: true })
  assert.equal(stream.k, 'activity')
  assert.equal(stream.tool, 'Bash')
  assert.equal(stream.summary, 'npm test')
})

test('approval → approval 卡片', () => {
  const stream = toStreamItem({ k: 'approval', seq: 3, at: 5, id: 'a1', cmd: 'Bash' })
  assert.equal(stream.k, 'approval')
  assert.equal(stream.id, 'a1')
})

test('轮次结束的 note → done 帧', () => {
  assert.equal(toStreamItem({ k: 'note', seq: 4, at: 5, text: '本轮结束' }).k, 'done')
  assert.equal(toStreamItem({ k: 'note', seq: 4, at: 5, text: '本轮失败' }).ok, false)
})

test('其它 note / think / file 不进聊天流（详情页才看）', () => {
  assert.equal(toStreamItem({ k: 'note', seq: 5, at: 5, text: '会话标题：x' }), undefined)
  assert.equal(toStreamItem({ k: 'think', seq: 6, at: 5, summary: '思考' }), undefined)
  assert.equal(toStreamItem({ k: 'file', seq: 7, at: 5, path: 'a.ts', op: 'mod' }), undefined)
})

// ── 历史回放（对话页空白的根因）──────────────────────────────────────────

test('user/message 必须映射（否则历史里"我说的话"会消失）', () => {
  const item = toTraceItem({ type: 'user/message', seq: 1, at: 1, data: { content: [{ type: 'text', text: '你好' }] } })
  assert.equal(item.k, 'user')
  assert.equal(item.text, '你好')
})

test('user 消息能投影成聊天流', () => {
  const stream = toStreamItem({ k: 'user', seq: 1, at: 1, text: '你好' })
  assert.equal(stream.k, 'user')
  assert.equal(stream.text, '你好')
})

console.log(`\n${passed} passed`)
