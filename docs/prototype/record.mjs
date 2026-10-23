/**
 * 录两段演示视频（mp4），输出到 ../ui/。
 *
 *   node record.mjs                 # 两段都录
 *   node record.mjs phone           # 只录手机
 *
 * 为什么不是"录屏软件"：
 *   录屏软件录的是桌面，会带进鼠标、通知、窗口边框；而这里要的是"界面上发生的事"。
 *   用 CDP 的 Page.startScreencast 直接拿渲染帧，帧是干净的，尺寸也精确等于设好的视口。
 *
 * 为什么每帧用时间戳算时长，而不是固定 30fps：
 *   startScreencast 只在**画面变化时**出帧，静止的两秒只会来一两帧。
 *   按固定帧率拼会把停顿压掉、把动作拉长，节奏全乱。按相邻帧的时间差写 duration 才还原真实节奏。
 *
 * 编码器用 imageio-ffmpeg 自带的那份（本机没装系统 ffmpeg）：
 *   pip install imageio-ffmpeg  →  python -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import puppeteer from 'puppeteer-core'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'ui')
const tmpDir = join(here, '.frames')

const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
].find(p => existsSync(p))

const FFMPEG = process.env.FFMPEG_PATH || [
  '/Users/ysmac/.workbuddy/binaries/python/envs/default/lib/python3.13/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1',
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
].find(p => existsSync(p))

if (!CHROME) { console.error('找不到 Chrome'); process.exit(1) }
if (!FFMPEG) { console.error('找不到 ffmpeg：pip install imageio-ffmpeg，或 FFMPEG_PATH=... node record.mjs'); process.exit(1) }

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' }

function serve(root) {
  return new Promise(resolve => {
    const srv = createServer(async (req, res) => {
      const path = decodeURIComponent(req.url.split('?')[0])
      try {
        const buf = await readFile(join(root, path === '/' ? 'index.html' : path))
        res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' })
        res.end(buf)
      } catch { res.writeHead(404); res.end('not found') }
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const TAB_LAND = { width: 1194, height: 834, deviceScaleFactor: 2, isMobile: true, hasTouch: true }

/** 一段视频 = 一个视口 + 一串动作。动作只有四种，够讲清楚这个产品。 */
const CLIPS = [
  {
    file: 'demo-phone',
    note: '手机竖屏：设备 → 会话 → 批准 → 执行过程 → 队列 → 文件 → 仓库 → diff',
    viewport: PHONE,
    // scale 2：把 390×844 的页面放进 780×1688 的画框里录，文字按 2 倍栅格化
    scale: 2,
    cast: { maxWidth: 780, maxHeight: 1688 },
    steps: [
      ['wait', 1400],
      ['click', '#s-devices .term.hot'],          // 锁定卡 → 会话
      ['wait', 1500],
      ['click', '#s-sessions .srow'],             // 等待中的会话 → 对话
      ['wait', 900],
      ['scroll', '#chatScroll'],                  // 滚到最新
      ['wait', 1500],
      ['click', '#s-chat [data-seg="trace"]'],
      ['wait', 2200],
      ['click', '#s-trace [data-seg="changes"]'],
      ['wait', 1700],
      ['click', '#s-changes [data-seg="chat"]'],
      ['wait', 700],
      ['click', '#s-chat .qbar'],                 // 展开队列
      ['wait', 2000],
      ['click', '#s-queue .fold'],                // 收起
      ['wait', 600],
      ['click', '[data-tab="files"]'],
      ['wait', 1700],
      ['click', '#s-files .f2.file[data-go]'],    // 打开文件
      ['wait', 1700],
      ['click', '#s-file [data-back]'],
      ['wait', 400],
      ['click', '#s-files [data-go="repo"]'],     // 仓库
      ['wait', 1700],
      ['click', '#s-repo .commit'],               // 提交详情
      ['wait', 2400],
    ],
  },
  {
    file: 'demo-tablet',
    note: '平板横屏：对话与执行过程同屏，右边跟着滚',
    viewport: TAB_LAND,
    cast: { maxWidth: 1600, maxHeight: 1120 },
    steps: [
      ['goto', 'chat'],
      ['wait', 1600],
      ['scroll', '#chatScroll'],
      ['wait', 1400],
      ['scroll', '#chatSideBody'],                // 右栏独立滚动——这正是双栏的意义
      ['wait', 1400],
      ['scrollTop', '#chatSideBody', 0],
      ['wait', 900],
      ['click', '#s-chat [data-seg="changes"]'],
      ['wait', 1800],
      ['click', '#s-changes [data-seg="chat"]'],
      ['wait', 700],
      ['click', '[data-tab="repo"]'],
      ['wait', 1900],
      ['click', '#s-repo .commit'],
      ['wait', 2000],
    ],
  },
]

const only = process.argv[2]
const clips = only ? CLIPS.filter(c => c.file.includes(only)) : CLIPS

await mkdir(outDir, { recursive: true })
const { srv, port } = await serve(here)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  // 原因同 capture.mjs：Chrome 的渲染沙箱叠在工具的沙箱里会让新页面直接崩
  args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'],
})

for (const clip of clips) {
  const scaleFactor = clip.scale || 1
  const page = await browser.newPage()
  // scale>1 时窗口本身要放大：iframe 已经 scale 2，窗口还留在 390 就只能看到左上四分之一
  await page.setViewport(scaleFactor > 1
    ? { width: clip.viewport.width * scaleFactor, height: clip.viewport.height * scaleFactor, deviceScaleFactor: 1 }
    : clip.viewport)
  const client = await page.createCDPSession()

  const frames = []
  client.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
    frames.push({ data, ts: metadata.timestamp })
    // 不回 ack 就只出这一帧，后面全静默——这个坑没有报错，只表现为"视频卡住"
    await client.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })

  const scale = clip.scale || 1
  const inner = `index.html?shot=1#devices`
  const url = scale > 1
    ? `http://127.0.0.1:${port}/frame.html?src=${encodeURIComponent(inner)}&w=${clip.viewport.width}&h=${clip.viewport.height}&s=${scale}`
    : `http://127.0.0.1:${port}/${inner}`
  await page.goto(url, { waitUntil: 'load' })
  // 动作要作用在真正的内容文档上：scale>1 时那是 iframe 里那份
  // 注意匹配方式：宿主的 URL 是 frame.html?src=index.html%3F...，用 includes('index.html')
  // 会把宿主自己也匹配上，于是所有点击都打在宿主的空文档上——表现为"视频停在第一帧"，
  // 而且没有任何报错。必须按路径精确比。
  const isInner = fr => fr.url().split('?')[0].endsWith('/index.html')
  const target = scale > 1
    ? await (async () => {
        const f = page.frames().find(isInner)
        if (f) return f
        await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.app'))
        return page.frames().find(isInner)
      })()
    : page
  await target.evaluate(() => (document.fonts && document.fonts.ready) || true)
  await client.send('Page.startScreencast', {
    format: 'jpeg', quality: 82, everyNthFrame: 1,
    maxWidth: clip.cast.maxWidth, maxHeight: clip.cast.maxHeight,
  })

  for (const [op, a, b] of clip.steps) {
    if (op === 'wait') await new Promise(r => setTimeout(r, a))
    if (op === 'click') await target.evaluate(s => document.querySelector(s)?.click(), a)
    if (op === 'goto') await target.evaluate(n => { location.hash = n }, a)
    if (op === 'scroll') await target.evaluate(s => {
      const el = document.querySelector(s); if (el) el.scrollTop = el.scrollHeight
    }, a)
    if (op === 'scrollTop') await target.evaluate(([s, v]) => {
      const el = document.querySelector(s); if (el) el.scrollTop = v
    }, [a, b])
  }
  await new Promise(r => setTimeout(r, 700))
  await client.send('Page.stopScreencast')
  await page.close()

  if (frames.length < 5) { console.warn(`! ${clip.file}: 只收到 ${frames.length} 帧，跳过`); continue }

  // 帧落盘 → concat 清单（duration 来自相邻帧时间差）
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(tmpDir, { recursive: true })
  const lines = []
  const names = []
  for (let i = 0; i < frames.length; i++) {
    const name = `f${String(i).padStart(5, '0')}.jpg`
    names.push(name)
    await writeFile(join(tmpDir, name), Buffer.from(frames[i].data, 'base64'))
  }
  for (let i = 0; i < frames.length; i++) {
    const next = frames[i + 1]?.ts ?? frames[i].ts + 0.4
    // 两个时间戳有时是同一毫秒（连续两帧同一次绘制），兜底 1/60 秒，否则 ffmpeg 会吞帧
    const dur = Math.max(1 / 60, Math.min(1.2, next - frames[i].ts))
    lines.push(`file '${names[i]}'`, `duration ${dur.toFixed(4)}`)
  }
  lines.push(`file '${names[frames.length - 1]}'`)
  await writeFile(join(tmpDir, 'list.txt'), lines.join('\n'))

  const out = join(outDir, `${clip.file}.mp4`)
  await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', join(tmpDir, 'list.txt'),
    // 偶数尺寸：H.264 的 yuv420p 要求宽高都是 2 的倍数
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p',
    '-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
    '-movflags', '+faststart', out,
  ])
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-i', out]).catch(e => ({ stdout: '', stderr: e.stderr }))
  const secs = /Duration: (\d+):(\d+):([\d.]+)/.exec(stdout)?.[0] || ''
  console.log(`✓ ${clip.file}.mp4  ${frames.length} 帧  ${secs}  ${clip.note}`)
}

await rm(tmpDir, { recursive: true, force: true })
await browser.close()
srv.close()
console.log(`\n输出目录：${outDir}`)
