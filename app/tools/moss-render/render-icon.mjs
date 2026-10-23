/**
 * 生成 App 启动图标。
 *
 * 流程：先用 3D 渲染出主体（透明背景），再在 canvas 里合成到深色圆角底上。
 * 两层分开做的好处是主体可以复用同一套渲染参数，图标只是换个底板。
 *
 * 输出 1024×1024（Android 自适应图标 / iOS App Store 的最小要求），
 * 其余密度由 uni-app 构建时自动缩放。
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const HERE = resolve(import.meta.dirname)
const OUT = resolve(HERE, '../../../app/src/static')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.webp': 'image/webp',
  '.fbx': 'application/octet-stream',
  '.png': 'image/png',
}

const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  const path = join(HERE, url === '/' ? 'page.html' : url)
  try {
    const b = await readFile(path)
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(b)
  } catch {
    res.writeHead(404); res.end()
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})

// ① 渲染透明背景的主体
const page = await browser.newPage()
await page.setViewport({ width: 1024, height: 1024 })
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' })
await page.waitForFunction('window.__ready === true', { timeout: 30000 })
const mossUrl = await page.evaluate(() => window.__render({
  width: 1024, height: 1024, yaw: 16, pitch: 8, working: false, format: 'png',
}))

// ② 合成到底板上
const icon = await browser.newPage()
await icon.setViewport({ width: 1024, height: 1024 })
await icon.goto(`http://127.0.0.1:${port}/icon.html`, { waitUntil: 'networkidle0' })
await icon.waitForFunction('window.__looksReady === true', { timeout: 10000 })
const png = await icon.evaluate((url) => window.__drawMoss(url), mossUrl)

await mkdir(OUT, { recursive: true })
const buf = Buffer.from(String(png).replace(/^data:image\/png;base64,/, ''), 'base64')
await writeFile(join(OUT, 'app-icon-1024.png'), buf)
console.log(`✓ app-icon-1024.png  ${(buf.byteLength / 1024).toFixed(1)}KB`)

await browser.close()
server.close()
