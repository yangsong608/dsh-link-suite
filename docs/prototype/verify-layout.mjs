/**
 * 四档画幅的布局自检 —— 不产图，只验"断点判对了没有"。
 *
 *   node verify-layout.mjs
 *
 * 为什么要有这个脚本：图能证明"某一档长这样"，但不能证明"另一档没有串味"。
 * 断点这类东西最典型的翻车是 844×390 的手机横屏被判成平板，侧栏一出来正文就没了。
 * 截图看不出来——那张图看上去只是"有点窄"。所以这里直接量 computedStyle 和几何。
 *
 * 判据来自 docs/08 §5 的表，一处不能差：
 *   手机竖屏  390×844  → rail 隐藏、tabbar 显示、side 隐藏
 *   手机横屏  844×390  → rail 隐藏、tabbar 显示、side 隐藏（宽度过 820 但不该判平板）
 *   平板竖屏  834×1194 → rail 显示 300、tabbar 隐藏、side 隐藏
 *   平板横屏 1194×834  → rail 显示 344、tabbar 隐藏、side 显示 348
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const here = dirname(fileURLToPath(import.meta.url))

const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(p => existsSync(p))

if (!CHROME) {
  console.error('找不到 Chrome。用 CHROME_PATH=/path/to/chrome node verify-layout.mjs')
  process.exit(1)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

function serve() {
  return new Promise(resolve => {
    const srv = createServer(async (req, res) => {
      // favicon 直接 204：原型没有图标，让浏览器把 404 记进控制台会盖住真问题
      if (req.url.startsWith('/favicon')) return res.writeHead(204).end()
      try {
        const p = join(here, decodeURIComponent(req.url.split('?')[0]))
        const body = await readFile(p)
        res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404).end('not found')
      }
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

/** 期望值。null 表示"不关心" */
const CASES = [
  { name: '手机竖屏 390×844',   vp: { width: 390,  height: 844 },
    rail: 'none', tabbar: 'flex', side: 'none',
    railW: 0, sideW: 0,
    // 单列：内容宽度不能被切成两栏
    contentMax: 390 },
  { name: '手机横屏 844×390',   vp: { width: 844,  height: 390 },
    rail: 'none', tabbar: 'flex', side: 'none',
    railW: 0, sideW: 0,
    contentMax: 844 },
  { name: '平板竖屏 834×1194',  vp: { width: 834,  height: 1194 },
    rail: 'flex', tabbar: 'none', side: 'none',
    railW: 300, sideW: 0,
    // 竖屏单列限宽 760；可用宽 = 834-300 = 534 < 760，所以铺满 534
    contentMax: 534 },
  { name: '平板横屏 1194×834',  vp: { width: 1194, height: 834 },
    rail: 'flex', tabbar: 'none', side: 'flex',
    railW: 344, sideW: 348,
    // 可用 1194-344 = 850，右栏 348 后对话 502
    contentMax: 502 },
]

const { srv, port } = await serve()
const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--hide-scrollbars'],
})
let failed = 0

for (const c of CASES) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  // favicon 的 404 不算问题——那是浏览器自己发的，跟页面无关
  page.on('console', m => {
    if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text())
  })

  await page.setViewport({ ...c.vp, deviceScaleFactor: 1 })
  // deep-link 的名字**不带 s- 前缀**（原型的 show() 自己拼 's-'+name），
  // 写成 #s-chat 会落空，is 判断失败后走 show('devices')，于是所有 rect 都是 0。
  await page.goto(`http://127.0.0.1:${port}/index.html#chat`, { waitUntil: 'networkidle0' })
  await new Promise(r => setTimeout(r, 320))

  const got = await page.evaluate(() => {
    const q = s => document.querySelector(s)
    const disp = s => { const el = q(s); return el ? getComputedStyle(el).display : '(missing)' }
    const w = s => { const el = q(s); return el ? Math.round(el.getBoundingClientRect().width) : -1 }
    const chatCol = q('.chat-col')
    return {
      rail: disp('.rail'), tabbar: disp('.tabbar'), side: disp('.side'),
      railW: w('.rail'), sideW: w('.side'),
      contentW: chatCol ? Math.round(chatCol.getBoundingClientRect().width) : -1,
      docW: document.documentElement.scrollWidth,
    }
  })

  const problems = []
  for (const k of ['rail', 'tabbar', 'side']) {
    if (got[k] !== c[k]) problems.push(`${k}.display=${got[k]} 期望 ${c[k]}`)
  }
  if (c.railW !== null && Math.abs(got.railW - c.railW) > 1) problems.push(`rail 宽 ${got.railW} 期望 ${c.railW}`)
  if (c.sideW !== null && Math.abs(got.sideW - c.sideW) > 1) problems.push(`side 宽 ${got.sideW} 期望 ${c.sideW}`)
  if (c.contentMax !== null && Math.abs(got.contentW - c.contentMax) > 2) {
    problems.push(`对话列宽 ${got.contentW} 期望 ${c.contentMax}`)
  }
  // 横向溢出：任何一档出现 docW > vp.width 都是断点算错了
  if (got.docW > c.vp.width) problems.push(`横向溢出 docW=${got.docW} > ${c.vp.width}`)
  if (errors.length) problems.push(`控制台报错 ${errors.length} 条：${errors[0]}`)

  if (problems.length) { failed++; console.log(`  FAIL  ${c.name}`); problems.forEach(p => console.log(`        · ${p}`)) }
  else console.log(`  ok    ${c.name}  rail=${got.rail}/${got.railW}px  side=${got.side}/${got.sideW}px  对话=${got.contentW}px`)
  await page.close()
}

await browser.close()
srv.close()
console.log(`\n${CASES.length - failed}/${CASES.length} 通过`)
process.exit(failed ? 1 : 0)
