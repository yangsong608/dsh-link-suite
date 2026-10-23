import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const HERE = resolve(import.meta.dirname)
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.webp':'image/webp', '.fbx':'application/octet-stream' }
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  const path = join(HERE, url === '/' ? 'page.html' : url)
  try { const b = await readFile(path); res.writeHead(200, {'content-type': MIME[extname(path)] ?? 'application/octet-stream'}); res.end(b) }
  catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0,'127.0.0.1',r))
const browser = await puppeteer.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:'new', args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
await page.setViewport({width:512,height:512})
await page.goto(`http://127.0.0.1:${server.address().port}/`, {waitUntil:'networkidle0'})
await page.waitForFunction('window.__ready === true', {timeout:30000})
// 先渲染一次让模型加载完成
await page.evaluate(() => window.__render({ width:512, height:512, yaw:0, pitch:0, working:false }))
console.log(JSON.stringify(await page.evaluate(() => window.__probe()), null, 2))
await browser.close(); server.close()
