/**
 * 把 MOSS 主体渲染成静态图（启动页 / 设备页与会话页的角标）。
 *
 * 为什么是预渲染而不是运行时 Three.js：
 *   Three.js 656KB + FBX 1MB，会把 App 首包从 360KB 推到约 2MB，
 *   而项目有明确的 400KB 首包预算（docs/05 §8）。设备页右上角的角标
 *   只是"这台机器在不在干活"的指示器，不值得为它加载一个 3D 引擎。
 *
 * 渲染内容：只保留机身（Moss_Main / Moss_Annexes / Moss_Glass），
 * 机械臂（Moss_arm）隐藏——它是独立网格，去掉之后更像一枚设备指示灯。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const HERE = resolve(import.meta.dirname)
const OUT = resolve(HERE, '../../../app/src/static/moss')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp',
  '.fbx': 'application/octet-stream',
  '.png': 'image/png',
}

// 极简静态服务：只暴露本目录（page.html + assets3d 符号链接）
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  const path = join(HERE, url === '/' ? 'page.html' : url)
  try {
    const body = await readFile(path)
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('not found')
  }
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
console.log(`静态服务 :${port}`)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.error('[页面错误]', m.text()) })
page.on('pageerror', (e) => console.error('[页面异常]', e.message))

await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 1 })
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' })
await page.waitForFunction('window.__ready === true', { timeout: 30_000 })

await mkdir(OUT, { recursive: true })

/** 每一档：文件名 + 渲染参数。 */
const shots = [
  // 启动页：偏 3/4 侧、略俯，能看出是立体的
  { name: 'boot', width: 640, height: 640, yaw: 24, pitch: 10, working: false },
  // 角标：正脸，小尺寸（在 28px 里不能有太多细节）
  { name: 'badge-idle', width: 160, height: 160, yaw: 12, pitch: 6, working: false },
  { name: 'badge-work', width: 160, height: 160, yaw: 12, pitch: 6, working: true },
  // 我的页面 / 关于页用的大图
  // hero 只在我的页面里以 ~120px 展示，900px 是浪费（650KB）。
  // 320px 在 3x 屏上仍够清晰。
  { name: 'hero', width: 320, height: 320, yaw: 20, pitch: 8, working: false },
]

for (const shot of shots) {
  const dataUrl = await page.evaluate((o) => window.__render({ ...o, format: 'webp', quality: 0.92 }), shot)
  const m = /^data:image\/(webp|png);base64,(.*)$/.exec(String(dataUrl))
  if (m === null) throw new Error(`无法解析渲染结果：${String(dataUrl).slice(0, 40)}`)
  const ext = m[1]
  const buf = Buffer.from(m[2], 'base64')
  const file = join(OUT, `${shot.name}.${ext}`)
  await writeFile(file, buf)
  console.log(`✓ ${shot.name}.${ext}  ${shot.width}×${shot.height}  ${(buf.byteLength / 1024).toFixed(1)}KB`)
}

await browser.close()
server.close()
console.log(`\n输出目录：${OUT}`)
