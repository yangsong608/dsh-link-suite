/**
 * UI 验证工具：在真实浏览器里渲染 H5 产物，用假的 WebSocket 喂数据。
 *
 * 为什么需要它：
 *   1. H5 默认被网关的 Origin 检查挡住，连不上真实宿主，
 *      于是"有数据的界面"在浏览器里根本看不到——只能靠打包到手机上看。
 *   2. Puppeteer 拦不住 WebSocket，所以这里在页面脚本执行前
 *      替换 window.WebSocket，用一个讲 dshlink 协议的替身。
 *      （改的是浏览器环境，不是产品代码。）
 *
 * 用法：
 *   node ui-harness.mjs                  # 手机 + 平板各截一轮
 *   node ui-harness.mjs 390x844          # 只截指定尺寸
 *
 * 产物写到 /tmp/ui-<page>-<w>x<h>.png
 */

import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'

const BASE = process.env.H5_BASE ?? 'http://127.0.0.1:5188'
const OUT = process.env.OUT_DIR ?? '/tmp/ui-shots'

/* ── 假数据 ──────────────────────────────────────────────────────────── */

const now = Date.now()

const DEVICES = [
  {
    deviceId: 'dev_a', name: 'MacBook Pro', platform: 'darwin', role: 'operator',
    createdAt: now - 86_400_000 * 3, lastSeen: now - 40_000,
  },
  {
    deviceId: 'dev_b', name: '书房的 Mac mini', platform: 'darwin', role: 'viewer',
    createdAt: now - 86_400_000 * 12, lastSeen: now - 7_200_000,
  },
]

const WORKSPACES = [
  {
    id: 'ws_a', name: 'deepseek', path: '/Volumes/work/deepseek', pinned: false,
    sessionCount: 4, updatedAt: now, sessionIds: ['s1', 's2', 's3', 's4'],
  },
  {
    id: 'ws_b', name: 'ajl/projects', path: '/Volumes/work/zkxh/ajl/projects', pinned: false,
    sessionCount: 2, updatedAt: now - 3_600_000, sessionIds: ['s5', 's6'],
  },
]

const SESSIONS = [
  { id: 's1', workspaceId: 'ws_a', title: '重构上传通道，加上断点续传', status: 'waiting-approval', updatedAt: now - 120_000, excerpt: '需要你确认：写入 dist/ 下 3 个文件' },
  { id: 's2', workspaceId: 'ws_a', title: '把 auth 换成 JWT 并补测试', status: 'running', updatedAt: now - 600_000, excerpt: '正在跑 npm test' },
  { id: 's3', workspaceId: 'ws_a', title: '分析 dsh-link-suite 工程', status: 'done', updatedAt: now - 7_200_000 },
  { id: 's4', workspaceId: 'ws_a', title: '修复 DeepSeek Harness 插件问题', status: 'done', updatedAt: now - 86_400_000 },
  { id: 's5', workspaceId: 'ws_b', title: '发版脚本校验 war 完整性', status: 'error', updatedAt: now - 180_000, excerpt: 'ZipException' },
  { id: 's6', workspaceId: 'ws_b', title: '导出销售日报', status: 'idle', updatedAt: now - 172_800_000 },
]

/** 队列（dsh 的 agent inbox）：两条待发，一条插话。 */
const QUEUE = {
  nextTurn: [
    { itemId: 'q1', text: '顺便把重试次数加到 5' },
    { itemId: 'q2', text: '跑完给我看下 dist 体积' },
  ],
  nextStep: [{ itemId: 'q3', text: '先别动 package.json' }],
}

/** 产物：本轮改动的文件（近似，来自文件工具记录）。 */
const CHANGES = {
  files: [
    { path: 'app/src/core/upload.ts', op: 'mod', additions: 42, deletions: 8 },
    { path: 'app/src/core/upload.spec.ts', op: 'add', additions: 61, deletions: 0 },
    { path: 'docs/05-上传通道.md', op: 'del', additions: 0, deletions: 23 },
  ],
  approximate: true,
  note: '来自会话事件里的文件工具记录；不含 shell 改动、二进制与 git 操作',
}

const HUNKS = {
  path: 'app/src/core/upload.ts',
  hunks: [
    { t: ' ', s: 'export async function upload(file: File) {' },
    { t: '-', s: '  const body = await file.arrayBuffer()' },
    { t: '-', s: '  return transport.send(body)' },
    { t: '+', s: '  const CHUNK = 8 * 1024 * 1024' },
    { t: '+', s: '  for (let offset = 0; offset < file.size; offset += CHUNK) {' },
    { t: '+', s: '    await transport.sendChunk(file.slice(offset, offset + CHUNK), offset)' },
    { t: '+', s: '  }' },
    { t: ' ', s: '}' },
  ],
}

const MODELS = {
  default: { provider: 'deepseek-account', model: 'deepseek-flash' },
  groups: [
    { provider: 'deepseek-account', name: 'DeepSeek Account', models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'deepseek-pro', name: 'DeepSeek-V4-Pro' },
    ] },
    { provider: 'workbuddy', name: 'WorkBuddy', models: [
      { id: 'hy4', name: 'Hy4 preview' },
      { id: 'hy3', name: 'Hy3' },
    ] },
  ],
  failures: [],
}

/** 会话历史：一段真实的对话，包含用户消息、思考、工具、审批卡、产物。 */
const HISTORY = [
  { t: 'user/message', data: { text: '上传通道现在是整文件一次性传，大文件会超时。改成 8MB 分片，要支持断点续传。' } },
  { t: 'assistant/message', data: { text: '先看一下现在的实现，确认上传入口在哪里。' } },
  { t: 'tool/call', data: { name: 'Read', arguments: JSON.stringify({ file_path: 'app/src/core/upload.ts' }), callId: 'c1' } },
  { t: 'tool/result', data: { message: { content: [{ type: 'text', text: 'export async function upload(file) {...}' }] } } },
  { t: 'tool/call', data: { name: 'Grep', arguments: JSON.stringify({ pattern: 'CHUNK_BYTES' }), callId: 'c2' } },
  { t: 'tool/result', data: { message: { content: [{ type: 'text', text: '3 matches' }] } } },
  { t: 'assistant/message', data: { text: '入口找到了。现在改成按 8MB 分片，并在 manifest 里记分片偏移，断线后从最后一个成功分片续传。' } },
  { t: 'tool/call', data: { name: 'Bash', arguments: JSON.stringify({ command: 'npm test -- upload' }), callId: 'c3' } },
  { t: 'tool/result', data: { message: { content: [{ type: 'text', text: 'PASS 12 tests' }] } } },
  { t: 'approval/asked', data: { id: 'ap1', toolName: 'Write', reason: '写入 dist/ 下 3 个文件（+1.2 MB）' } },
]

/* ── 替身 WebSocket ──────────────────────────────────────────────────── */

/**
 * 在页面里安装假 WebSocket。
 *
 * 它只实现应用真正用到的那几个接口：open/message/close/error 事件、
 * send、readyState。收到 req 帧就按方法名回 res 帧，
 * 订阅类方法额外推 evt 帧（历史回放）。
 */
function installMockSocket() {
  const RealWS = window.WebSocket

/** TraceItem 形状（与服务端 adapters/sessions.ts 的产出保持一致）。 */
function toTrace(ev, seq) {
  const d = ev.data ?? {}
  const base = { seq, at: Date.now() - (20 - seq) * 60_000 }
  switch (ev.t) {
    case 'user/message': return { ...base, k: 'user', text: d.text }
    case 'assistant/message': return { ...base, k: 'text', text: d.text }
    case 'tool/call': {
      let target
      try {
        const a = JSON.parse(d.arguments ?? '{}')
        target = a.command ?? a.file_path ?? a.pattern ?? undefined
      } catch { /* 忽略 */ }
      return { ...base, k: 'tool', tool: d.name, phase: 'call', ...(target ? { target } : {}) }
    }
    case 'tool/result': return { ...base, k: 'tool', tool: '', phase: 'result', ok: true }
    case 'approval/asked': return { ...base, k: 'approval', id: d.id, tool: d.toolName, reason: d.reason }
    default: return { ...base, k: 'think', summary: ev.t }
  }
}

function toStream(ev, seq, isHistory) {
  const t = toTrace(ev, seq)
  const tag = isHistory ? { history: true } : {}
  switch (t.k) {
    case 'user': return { k: 'user', text: t.text, at: t.at, ...tag }
    case 'text': return { k: 'assist', text: t.text, at: t.at, streaming: false, ...tag }
    case 'tool': return { k: 'activity', tool: t.tool, summary: t.target ?? '', phase: t.phase, ok: t.ok ?? true, ...tag }
    case 'approval': return { k: 'approval', id: t.id, tool: t.tool, reason: t.reason, ...tag }
    default: return { k: 'assist', text: '', at: t.at, ...tag }
  }
}

  // 记录谁在监听：uni 的 SocketTask 用 addEventListener 接事件
  const origAdd = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type, cb, opt) {
    if (this instanceof MockSocket) (window.__mockCalls ||= []).push('监听:' + type)
    return origAdd.call(this, type, cb, opt)
  }

  class MockSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    /*
     * 实例上也要有这些常量。
     *
     * 真实 WebSocket 把 OPEN 等同时挂在构造器和原型上，而 uni-app 的
     * SocketTask.send 是这么判断的：
     *     if (ws.readyState !== ws.OPEN) throw ...
     * 只定义 static 的话 `ws.OPEN` 是 undefined，于是永远判为"没打开"，
     * 帧一个都发不出去——表现为"连上了但界面全空"。
     */
    #seq = 0

    get CONNECTING() { return 0 }
    get OPEN() { return 1 }
    get CLOSING() { return 2 }
    get CLOSED() { return 3 }

    constructor(url, protocols) {
      super()
      ;(window.__mockCalls ||= []).push('构造:' + String(url).slice(0, 40))
      this.url = url
      this.protocol = Array.isArray(protocols) ? protocols[0] : protocols
      this.readyState = MockSocket.CONNECTING
      this.onopen = null
      this.onmessage = null
      this.onclose = null
      this.onerror = null
      setTimeout(() => {
        this.readyState = MockSocket.OPEN
        this.#emit('open', {})
      }, 30)
    }

    #emit(type, ev) {
      ;(window.__mockCalls ||= []).push('emit:' + type)
      const handler = this[`on${type}`]
      if (typeof handler === 'function') handler.call(this, ev)
      try {
        const event = new Event(type)
        if (ev && 'data' in ev) event.data = ev.data
        if (ev && 'code' in ev) { event.code = ev.code; event.reason = ev.reason }
        this.dispatchEvent(event)
      } catch (err) {
        ;(window.__mockCalls ||= []).push('dispatch失败:' + String(err).slice(0, 60))
      }
    }

    #push(frame) {
      const data = JSON.stringify(frame)
      this.#emit('message', { data })
    }

    /** 发一条 evt。协议要求 evt 必须带 seq（每通道单调递增），少了会被客户端丢弃。 */
    #evt(ch, m, p) {
      this.#seq += 1
      this.#push({ t: 'evt', ch, seq: this.#seq, m, p })
    }

    send(raw) {
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (frame.t !== 'req') return
      const { id, m } = frame
      ;(window.__mockCalls ||= []).push(m)
      const reply = (r) => setTimeout(() => this.#push({ t: 'res', id, ok: true, r }), 20)
      const fail = (code, msg) => setTimeout(() => this.#push({ t: 'res', id, ok: false, e: { code, msg } }), 20)

      switch (m) {
        case 'device.info':
          return reply({ hostId: 'h_mock123456', dshVersion: '0.2.1-rc.1', lock: { armed: true, locked: false } })
        case 'device.list': return reply({ devices: window.__MOCK__.devices })
        case 'lock.status':
          return reply({ armed: true, hasPassword: true, locked: false, soft: false, failedAttempts: 0 })
        case 'workspace.list': return reply({ workspaces: window.__MOCK__.workspaces })
        case 'session.list': return reply({ sessions: window.__MOCK__.sessions })
        case 'session.create': return reply({ sessionId: 'session-new-1' })
        case 'session.modelCatalog': return reply(window.__MOCK__.models)
        case 'session.follow': {
          const sessionId = frame.p?.sessionId ?? 's1'
          reply({ channel: `sess:${sessionId}`, sessionId })
          // 之后异步回放历史，模拟真实宿主
          const ch = `sess:${sessionId}`
          const history = window.__MOCK__.history
          history.forEach((ev, i) => {
            setTimeout(() => {
              this.#evt(ch, 'session.stream', toStream(ev, i, true))
              this.#evt(ch, 'session.trace', toTrace(ev, i))
            }, 60 + i * 40)
          })
          setTimeout(() => {
            this.#evt(ch, 'session.history.end', { cursor: history.length, hasMore: false, pushed: history.length })
          }, 60 + history.length * 40 + 30)
          return
        }
        case 'session.queue.list': return reply(window.__MOCK__.queue)
        case 'session.queue.push': return reply({ ok: true })
        case 'session.queue.edit': return reply({ ok: true })
        case 'session.queue.remove': return reply({ ok: true })
        case 'session.queue.steer': return reply({ ok: true })
        case 'session.changes': return reply(window.__MOCK__.changes)
        case 'fs.upload': return reply({ receiptId: 'rcpt_mock_1', name: 'mock.txt', bytes: 1024, file: null })
        case 'cost.summary': return reply({
          available: true,
          session: { total: { amount: 0.4231, currency: 'USD' } },
          peak: { peak: true, weekend: false, msUntilSwitch: 2 * 3600 * 1000, next: 'offPeak' },
        })
        case 'session.diff': return reply(window.__MOCK__.hunks)
        case 'session.prompt':
          return reply({ ok: true, sessionId: frame.p?.sessionId })
        case 'session.cancel':
          return reply({ ok: true })
        case 'approval.answer':
          return reply({ ok: true })
        default:
          return reply({ ok: true })
      }
    }

    close() {
      if (this.readyState === MockSocket.CLOSED) return
      this.readyState = MockSocket.CLOSED
      this.#emit('close', { code: 1000, reason: '' })
    }
  }

  // 全部接管：这个工具的唯一用途就是"用假数据看界面"，
  // 放真实连接过去只会得到 ERR_NAME_NOT_RESOLVED 和一片空列表。
  window.WebSocket = new Proxy(RealWS, {
    construct(_target, args) {
      return new MockSocket(args[0], args[1])
    },
  })
}

/* ── 截图 ────────────────────────────────────────────────────────────── */

/**
 * 顺序有讲究：会话页必须排在对话页之前。
 * state 是模块级单例，同一页面内切路由不会重建；
 * 先进会话页把 session.list 灌进 state，对话页才拿得到真实标题。
 */
const PAGES = [
  ['devices', '/#/pages/index/index'],
  ['sessions', '/#/pages/sessions/sessions'],
  ['chat', '/#/pages/chat/chat?id=s1'],
  ['me', '/#/pages/me/me'],
]

const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet: { width: 834, height: 1112, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tabletLand: { width: 1112, height: 834, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
}

async function main() {
  // --light 时额外出一轮浅色主题截图（用于验证日间模式）
  const args = process.argv.slice(2).filter((a) => a !== '--light')
  const light = process.argv.includes('--light')
  const only = args[0]
  await mkdir(OUT, { recursive: true })

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--allow-insecure-localhost'],
  })

  const targets = only
    ? { custom: parseViewport(only) }
    : VIEWPORTS

  for (const [vpName, vp] of Object.entries(targets)) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)))

    await page.evaluateOnNewDocument(installMockSocket)
    await page.evaluateOnNewDocument((mock) => { window.__MOCK__ = mock }, {
      devices: DEVICES, workspaces: WORKSPACES, sessions: SESSIONS, models: MODELS, history: HISTORY,
      queue: QUEUE, changes: CHANGES, hunks: HUNKS,
    })
    // 设备表落盘，让首页直接进入"已配对"状态
    await page.evaluateOnNewDocument((seed, isLight) => {
      try {
        localStorage.setItem('dsh-link/devices', seed)
        localStorage.setItem('dsh-link/token/dev_a', 'mock-token')
        // 浅色模式：用户亲手改过（lightStored 由读缓存置位），跳过跟随系统
        if (isLight) localStorage.setItem('dsh-link/prefs', JSON.stringify({ skinMode: 'moss', light: true, lite: false }))
      } catch { /* 忽略 */ }
    }, JSON.stringify({
      activeId: 'dev_a',
      devices: [{
        deviceId: 'dev_a', name: 'MacBook Pro', platform: 'darwin', role: 'operator',
        createdAt: now - 86_400_000 * 3, lastSeen: now - 40_000,
        endpoint: { url: 'ws://mock:7443/dshlink', kind: 'lan' },
      }],
    }), light)

    await page.setViewport(vp)

    for (const [name, path] of PAGES) {
      await page.goto(BASE + path, { waitUntil: 'networkidle0' })
      // 启动动画 4.3s；等它播完再截
      // devices 页有 4.3s 启动动画；其余页面要等连接建立 + 首轮 refresh
      await new Promise((r) => setTimeout(r, name === 'devices' ? 5200 : 4200))
      const suffix = light ? '-light' : ''
      const file = `${OUT}/${name}-${vp.width}x${vp.height}${suffix}.png`
      await page.screenshot({ path: file })
      const calls = await page.evaluate(() => (window.__mockCalls ?? []).filter(c => !String(c).startsWith('emit:message')))
      console.log('✓', vpName, name, '→', file, '| mock 收到:', JSON.stringify(calls.slice(-6)))
    }

    if (errors.length > 0) console.log('  页面错误:', errors.slice(0, 3))
    await page.close()
  }

  await browser.close()
}

function parseViewport(text) {
  const m = /^(\d+)x(\d+)$/.exec(text)
  if (!m) throw new Error('尺寸格式应为 宽x高，例如 390x844')
  return { width: Number(m[1]), height: Number(m[2]), deviceScaleFactor: 2, isMobile: true, hasTouch: true }
}

await main()
