import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const HERE = resolve(import.meta.dirname)
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.webp':'image/webp','.fbx':'application/octet-stream','.png':'image/png' }
const server = createServer(async (req,res)=>{
  const u=decodeURIComponent((req.url??'/').split('?')[0])
  const path=join(HERE,u==='/'?'page.html':u)
  try{const b=await readFile(path);res.writeHead(200,{'content-type':MIME[extname(path)]??'application/octet-stream'});res.end(b)}
  catch{res.writeHead(404);res.end()}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader']})
const page=await browser.newPage()
await page.setViewport({width:640,height:640})
await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'networkidle0'})
await page.waitForFunction('window.__ready === true',{timeout:30000})

// 同一个模型，试不同角度，看哪个角度主体最亮
const angles = [
  { yaw: 0, pitch: 0, label: 'y0p0' },
  { yaw: 12, pitch: 6, label: 'y12p6' },
  { yaw: 24, pitch: 10, label: 'y24p10' },
  { yaw: 180, pitch: 0, label: 'y180p0' },
  { yaw: 0, pitch: -20, label: 'y0p-20' },
]
for (const a of angles) {
  const url = await page.evaluate((o)=>window.__render({width:640,height:640,yaw:o.yaw,pitch:o.pitch,working:false,format:'png'}), a)
  const buf = Buffer.from(String(url).replace(/^data:image\/png;base64,/,''),'base64')
  await writeFile(join('/tmp', `cmp-${a.label}.png`), buf)
  console.log(`渲染 ${a.label}`)
}
await browser.close(); server.close()
