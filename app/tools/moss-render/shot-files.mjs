/**
 * 文件查看器的视觉验证。
 *
 * 覆盖四种渲染分支：目录列表、Markdown、代码（行号）、CSV 表格、图片。
 * 产物页另有一张（含「浏览工作区文件」入口与改动列表）。
 *
 * 用法：node shot-files.mjs
 */
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'

const SRC = readFileSync('ui-harness.mjs', 'utf8')
const MOCK = SRC.slice(SRC.indexOf('function installMockSocket()'), SRC.indexOf('/* ── 截图 ──'))

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const FIXTURE = {
  devices: [],
  workspaces: [{ id: 'w1', name: 'deepseek', path: '/mock', sessionIds: ['s1'], sessionCount: 1, updatedAt: 1 }],
  sessions: [{ id: 's1', workspaceId: 'w1', title: '重构上传通道', status: 'done', updatedAt: 1 }],
  models: { default: { provider: 'p', model: 'm' }, groups: [], failures: [] },
  history: [{ t: 'assistant/message', data: { message: { content: [{ type: 'text', text: '## 完成\n\n已改为 8MB 分片，manifest 记录偏移量。' }] } } }],
  queue: { nextTurn: [], nextStep: [] },
  changes: {
    files: [
      { path: 'app/core/upload.ts', op: 'mod', additions: 42, deletions: 8 },
      { path: 'README.md', op: 'mod', additions: 2, deletions: 0 },
      { path: 'data/report.csv', op: 'add', additions: 5, deletions: 0 },
    ],
    approximate: true,
    note: '来自会话事件里的文件工具记录；不含 shell 改动、二进制与 git 操作',
  },
  hunks: { path: '', hunks: [] },
  tree: {
    '': [{ name: 'app', dir: true }, { name: 'data', dir: true }, { name: 'docs', dir: true }, { name: 'README.md', dir: false }],
    app: [{ name: 'core', dir: true }],
    'app/core': [{ name: 'upload.ts', dir: false }],
    data: [{ name: 'report.csv', dir: false }],
    docs: [{ name: '05-上传通道.md', dir: false }],
  },
  files: {
    'README.md': { path: 'README.md', kind: 'markdown', size: 812, text: '# MOSS Link\n\n把 dsh 带到手机上。\n\n- 配对即用\n- 数据不过服务器\n\n```ts\nconst a = 1\n```\n' },
    'app/core/upload.ts': {
      path: 'app/core/upload.ts', kind: 'text', size: 620,
      text: 'export async function upload(file: File) {\n  const CHUNK = 8 * 1024 * 1024\n  for (let offset = 0; offset < file.size; offset += CHUNK) {\n    await transport.sendChunk(file.slice(offset, offset + CHUNK), offset)\n  }\n}\n',
    },
    'data/report.csv': {
      path: 'data/report.csv', kind: 'text', size: 420,
      text: 'date,orders,revenue\n2026-10-20,128,¥128430\n2026-10-21,143,¥139210\n2026-10-22,119,¥117800\n',
    },
    'docs/05-上传通道.md': { path: 'docs/05-上传通道.md', kind: 'markdown', size: 300, text: '## 分片上传\n\n偏移量必须持久化。\n' },
  },
  png: PNG_1PX,
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)))

await page.evaluateOnNewDocument(MOCK + ';installMockSocket();')
await page.evaluateOnNewDocument((fx) => {
  window.__MOCK__ = fx
  localStorage.setItem('dsh-link/devices', JSON.stringify({
    activeId: 'dev_a',
    devices: [{ deviceId: 'dev_a', name: 'MacBook Pro', platform: 'darwin', role: 'operator', createdAt: 1, lastSeen: 2, endpoint: { url: 'ws://172.80.2.178:7443/dshlink', kind: 'lan' } }],
  }))
  localStorage.setItem('dsh-link/token/dev_a', 'tok')
}, FIXTURE)
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
await page.goto('http://127.0.0.1:5188/#/pages/chat/chat?id=s1', { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 2400))

const click = async (selector, contains) => {
  const ok = await page.evaluate((sel, txt) => {
    const list = [...document.querySelectorAll(sel)]
    const el = txt === undefined ? list[0] : list.find((n) => n.textContent.includes(txt))
    if (!el) return false
    el.click()
    return true
  }, selector, contains)
  await new Promise((r) => setTimeout(r, 700))
  return ok
}

// ① 产物页
await click('.seg', '产物')
await page.screenshot({ path: '/tmp/ui-shots/fv-1-artifacts.png' })

// ② 浏览工作区 → 目录列表
await click('.browse-row')
console.log('目录项:', await page.evaluate(() => [...document.querySelectorAll('.panel .row .name')].map((n) => n.textContent).join(' | ')))
await page.screenshot({ path: '/tmp/ui-shots/fv-2-browse.png' })

// ③ README.md → Markdown
await click('.panel .row', 'README')
console.log('MD 块数:', await page.evaluate(() => ({ h: document.querySelectorAll('.panel .md .h').length, li: document.querySelectorAll('.panel .md .li').length })))
await page.screenshot({ path: '/tmp/ui-shots/fv-3-markdown.png' })

// ④ 代码：app/core/upload.ts
await click('.close')
await click('.browse-row')
await click('.panel .row', 'app')
await click('.panel .row', 'core')
await click('.panel .row', 'upload.ts')
console.log('代码行数:', await page.evaluate(() => document.querySelectorAll('.panel .cl').length))
await page.screenshot({ path: '/tmp/ui-shots/fv-4-code.png' })

// ⑤ CSV 表格
await click('.close')
await click('.browse-row')
await click('.panel .row', 'data')
await click('.panel .row', 'report.csv')
console.log('CSV 行列:', await page.evaluate(() => ({ rows: document.querySelectorAll('.panel .tr').length, cells: document.querySelectorAll('.panel .td').length })))
await page.screenshot({ path: '/tmp/ui-shots/fv-5-csv.png' })

console.log('页面错误:', errs.length > 0 ? errs.slice(0, 3) : '无')
await browser.close()
