/**
 * 把 index.html 的各个 #<screen> 批量截成 UI 设计图，输出到 ../ui/。
 *
 *   node capture.mjs                # 全量
 *   node capture.mjs p3-trace       # 只重截一张（按输出名过滤）
 *
 * 三条约束，都不是随便定的：
 *   1. 视口默认 390×844 @3x —— docs/08 §2.1 的基准宽度就是 iPhone 14/15 的逻辑宽，
 *      deviceScaleFactor 3 让产物是 1170×2532，贴进文档里放大也清楚。
 *      平板与横屏各自覆盖 viewport，见下方 PHONE / TAB_* 四档。
 *   2. 用 puppeteer-core + 系统 Chrome，不用 puppeteer —— 后者每次都下一份 Chromium，
 *      为了 16 张图不值得。CI 上用 CHROME_PATH 指定即可。
 *   3. 必须等 document.fonts.ready —— 等宽字形没加载完就截，行号列会错位半像素，
 *      而这张图就是要给人看等宽对齐的。
 */
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'ui')

const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(p => existsSync(p))

if (!CHROME) {
  console.error('找不到 Chrome。装一个，或用 CHROME_PATH=/path/to/chrome node capture.mjs')
  process.exit(1)
}

/* 四档画幅。deviceScaleFactor 不同是故意的：
 * 手机 @3x（1170×2532）贴进文档放大看行号；平板 @2x 已经够 1668×2388 / 2388×1668。 */
const PHONE           = { width: 390,  height: 844,  deviceScaleFactor: 3, isMobile: true, hasTouch: true }
const PHONE_LANDSCAPE = { width: 844,  height: 390,  deviceScaleFactor: 3, isMobile: true, hasTouch: true }
const TAB_PORTRAIT    = { width: 834,  height: 1194, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const TAB_LANDSCAPE   = { width: 1194, height: 834,  deviceScaleFactor: 2, isMobile: true, hasTouch: true }

/** screen = #s-<screen>；query 追加到 URL；note 只写进控制台，不进图 */
const SHOTS = [
  { file: 'p1-devices',         screen: 'devices',  note: '设备首页（MOSS 深色）' },
  { file: 'p1-devices-550w',    screen: 'devices',  query: 'skin=550w', note: '同一页切 550W' },
  { file: 'p2-sessions',        screen: 'sessions', note: '会话列表（三分组 + 设备名）' },
  // 聊天记录有历史，截图必须滚到最新一条：否则画面上是"昨天的对话"，
  // 而这张图要讲的是"现在等你批准"。scroll 在页面加载后执行。
  { file: 'p3-chat',            screen: 'chat',     scroll: '#chatScroll', note: '对话段（三段切换 + 队列收起条）' },
  { file: 'p3-trace',           screen: 'trace',    note: '执行过程段（九种行）' },
  { file: 'p3-changes',         screen: 'changes',  note: '产物段（本轮改动）' },
  { file: 'p4-queue',           screen: 'queue',    note: '队列展开态' },
  { file: 'p5-files',           screen: 'files',    note: '文件浏览（面包屑 + git 状态字母）' },
  { file: 'p6-file-view',       screen: 'file',     note: '文件预览（行号 + 改动行）' },
  // 同一页的另一种渲染形态：08 §3.7 的规格表里代码与图片是两行，图也得是两张。
  // 只给代码不给图片，接的时候容易把图片也当代码去分行号。
  { file: 'p6-file-image',      screen: 'file',     query: 'mode=image', note: '文件预览：图片等比适配 + 最大高 60vh' },
  { file: 'p7-repo',            screen: 'repo',     note: '仓库视图（暂存分组 + 历史）' },
  { file: 'p8-diff',            screen: 'diff',     note: '提交详情与 diff' },
  { file: 'p9-plugins',         screen: 'plugins',  note: '插件页' },
  { file: 'p10-settings',       screen: 'settings', note: '设置（外观 / 会话 / 文件 / 安全 / 锁定）' },
  { file: 'p11-locked-banner',  screen: 'locked',   note: '手机端锁定提示（条目级裁剪）' },
  { file: 'p11-unlock-request', screen: 'locked',   note: '请求解锁抽屉', click: '#s-locked .lockbanner .act' },
  // 锁屏是 dsh 窗口整屏的状态，按 1280×800 出图；其余都是手机页面
  { file: 'p11-lock-screen',    screen: 'lock',     query: 'frame=pc', note: 'dsh 侧锁屏（550W 强制）',
    viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } },
  { file: 'p12-pair',           screen: 'pair',     note: '配对' },

  /* ── 同一套界面的另外三种画幅 ──────────────────────────────────────
   * 设计图只出手机竖屏，是这一版最容易造成的误读：评审会以为"平板就是放大的手机"。
   * 实际上平板横屏是**另一种布局**（双栏：对话 + 执行过程），手机横屏是**另一套密度**。
   * 下面五张专门用来钉死这件事，参数见 docs/08 §5。 */
  { file: 'p13-tab-portrait',       screen: 'chat',  scroll: '#chatScroll',
    note: '平板竖屏 834×1194：侧栏 + 单列，无底部 Tab', viewport: TAB_PORTRAIT },
  { file: 'p14-tab-portrait-files', screen: 'files', note: '平板竖屏：内容限宽 760，面包屑不贴边',
    viewport: TAB_PORTRAIT },
  { file: 'p15-tab-landscape',      screen: 'chat',  scroll: '#chatScroll',
    note: '平板横屏 1194×834：对话 + 执行过程双栏（关键一图）', viewport: TAB_LANDSCAPE },
  { file: 'p16-tab-landscape-diff', screen: 'diff',  note: '平板横屏：diff 双列行号在宽屏下的可读性',
    viewport: TAB_LANDSCAPE },
  { file: 'p17-phone-landscape',    screen: 'chat',  scroll: '#chatScroll',
    note: '手机横屏 844×390：不触发侧栏，只压竖向的壳', viewport: PHONE_LANDSCAPE },
]

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' }

/** 起一个最小静态服务器：file:// 下 localStorage 会被当成 opaque origin，皮肤选择读不出来 */
function serve(root) {
  return new Promise(resolve => {
    const srv = createServer(async (req, res) => {
      const path = decodeURIComponent(req.url.split('?')[0])
      const file = join(root, path === '/' ? 'index.html' : path)
      try {
        const buf = await readFile(file)
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
        res.end(buf)
      } catch {
        res.writeHead(404); res.end('not found')
      }
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

const only = process.argv[2]
const list = only ? SHOTS.filter(s => s.file.includes(only)) : SHOTS
if (!list.length) { console.error(`没有匹配 "${only}" 的图`); process.exit(1) }

await mkdir(outDir, { recursive: true })
const { srv, port } = await serve(here)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  /*
   * --no-sandbox 不是图省事。Chrome 155 的渲染进程沙箱与打包工具自身的沙箱叠在一起时，
   * 新建页面会在 Emulation.setTouchEmulationEnabled 处直接 Session closed，
   * 而 --headless=shell 更糟（连主帧都拿不到）。截图是本机一次性任务，关掉渲染沙箱可接受；
   * 真要在 CI 上跑，用容器自带的隔离，不要依赖 Chrome 内层沙箱。
   */
  args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'],
})

const page = await browser.newPage()
await page.setViewport(PHONE)

for (const s of list) {
  await page.setViewport(s.viewport || PHONE)
  const q = ['shot=1', s.query].filter(Boolean).join('&')
  const url = `http://127.0.0.1:${port}/index.html?${q}#${s.screen}`
  await page.goto(url, { waitUntil: 'load' })
  await page.evaluate(() => (document.fonts && document.fonts.ready) || true)
  // 有些图是"某个状态"，不是"某个页面"：先点一下再截（比如请求解锁的抽屉）
  if (s.click) {
    await page.evaluate(sel => document.querySelector(sel)?.click(), s.click)
    await new Promise(r => setTimeout(r, 320))
  }
  // 两帧：一帧让 hashchange/show() 生效，一帧让入场动画落到终态
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  await new Promise(r => setTimeout(r, 260))

  // 滚动到底：聊天记录默认停在最新一条（真实交互也是这样）
  if (s.scroll) {
    await page.evaluate(sel => {
      const el = document.querySelector(sel)
      if (el) el.scrollTop = el.scrollHeight
    }, s.scroll)
  }
  // scrollTo：把某个元素顶到可视区顶部。手机横屏只剩 222px 的对话区，
  // 滚到底只能看到一张审批卡——那不是"横屏的样子"，那是"卡的样子"。
  if (s.scrollTo) {
    await page.evaluate(sel => {
      document.querySelector(sel)?.scrollIntoView({ block: 'start' })
    }, s.scrollTo)
  }

  // 自检：这几张新页面里最容易出问题的是"横向溢出"（flex 子项 min-height / box-sizing）。
  // 溢出在截图上看不出来（被 overflow:hidden 裁掉），所以必须量。
  const bad = await page.evaluate(() => {
    const el = document.querySelector('.screen.on')
    if (!el) return 'no active screen'
    // 只看"真的会漏到页面外"的溢出：overflow 不是 visible 的容器自己会滚/裁，不算问题。
    // diff 的 .scroll 与配对的 .finder 都属于这一类——它们本来就该在内部滚。
    // 还要看祖先有没有裁：diff 行溢出的那几十像素会被 .scroll 的 overflow-x:auto 吃掉，
    // 真正的"漏出页面"必须是漏到 .screen 之外
    const clipped = n => {
      for (let p = n.parentElement; p && !p.classList.contains('screen'); p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') return true
      }
      return false
    }
    const leak = n => {
      const cs = getComputedStyle(n)
      return cs.overflowX === 'visible' && n.scrollWidth > n.clientWidth + 1 && n.clientWidth > 0 && !clipped(n)
    }
    const over = [...el.querySelectorAll('*')].filter(leak)
    const page = document.documentElement.scrollWidth > window.innerWidth + 1
    if (page) return `页面横向溢出（${document.documentElement.scrollWidth} > ${window.innerWidth}）`
    return over.length ? `${over.length} 个元素横向漏出（首个：${over[0].className}）` : ''
  })
  if (bad) console.warn(`  ! ${s.file}: ${bad}`)

  await page.screenshot({ path: join(outDir, `${s.file}.png`) })
  const vp = s.viewport || PHONE
  console.log(`✓ ${s.file}.png  ${vp.width}×${vp.height}@${vp.deviceScaleFactor}x  ${s.note}`)
}

await browser.close()
srv.close()
console.log(`\n${list.length} 张输出到 ${outDir}`)
