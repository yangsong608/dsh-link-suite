/**
 * 截 App 的真实 H5 渲染 —— 不是原型，是 `moss-ai-app/src` 编译出来的东西。
 *
 *   node shot-app.mjs
 *
 * 为什么这张图和 `p*.png` 要分开：
 * `p*.png` 出自 `index.html`（设计原型），它证明"设计定了"；
 * 这张出自 `moss-ai-app/dist/build/h5`（真代码），它证明"代码跑起来了"。
 * 两者混为一谈是这类项目最常见的自欺——原型再漂亮，也不代表 App 能渲染。
 *
 * 前置：先在 moss-ai-app/ 下 `npm run build:h5`。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, '..', '..', '..', 'moss-ai-app', 'dist', 'build', 'h5')
// 放 prototype 而不是 ui/：ui/ 里那 23 张是"设计图"（出自 index.html），
// 这一张是"实现凭证"（出自 moss-ai-app/dist）。两个目录混放，评审会分不清哪张能做准。
const out = resolve(here, 'app-h5-devices.png')

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`找不到 ${dist}/index.html。先在 moss-ai-app/ 下跑 npm run build:h5`)
  process.exit(1)
}

const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
].find(p => existsSync(p))

if (!CHROME) {
  console.error('找不到 Chrome。用 CHROME_PATH=/path/to/chrome node shot-app.mjs')
  process.exit(1)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

// uni-app 的 H5 用 hash 路由，静态服务只需原样吐文件
const srv = createServer(async (req, res) => {
  if (req.url.startsWith('/favicon')) return res.writeHead(204).end()
  const rel = decodeURIComponent(req.url.split('?')[0])
  const p = join(dist, rel === '/' ? 'index.html' : rel)
  try {
    const body = await readFile(p)
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    // SPA 兜底：认不出的路径给 index.html，否则刷新会 404
    try {
      res.writeHead(200, { 'content-type': TYPES['.html'] })
      res.end(await readFile(join(dist, 'index.html')))
    } catch {
      res.writeHead(404).end('not found')
    }
  }
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port

const browser = await puppeteer.launch({
  executablePath: CHROME,
  // 与 capture.mjs 同样的理由：Chrome 155 的渲染沙箱与打包工具叠加时，
  // 新建页面会在 Emulation.setTouchEmulationEnabled 处直接 Session closed。
  args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'],
})

const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => {
  if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text())
})

// @2x 就够：这张图是让人确认"真跑起来了"，不是给人放大了看行号
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' })

// 冷启动四阶段动画（550W → 反转 → MOSS）约 1.4s，等它走完再截，
// 否则截到的是启动遮罩而不是页面。
await new Promise(r => setTimeout(r, 2000))
await page.evaluate(() => {
  // 页面里有滚动容器时先归位，避免上一次的滚动位置带进来
  document.querySelectorAll('.scroll, uni-page-wrapper').forEach(el => (el.scrollTop = 0))
})
await new Promise(r => setTimeout(r, 260))

await page.screenshot({ path: out })
await browser.close()
srv.close()

if (errors.length) {
  console.log(`⚠ 页面有 ${errors.length} 条控制台报错（图已出，但请先看这些）：`)
  errors.slice(0, 5).forEach(e => console.log(`   · ${e}`))
  process.exitCode = 1
} else {
  console.log(`✓ ${out}  (390×844 @2x，零控制台报错)`)
}
