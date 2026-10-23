import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
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
await page.evaluate(()=>window.__render({width:640,height:640,yaw:0,pitch:0}))
const items = await page.evaluate(()=>window.__scene())
for (const it of items) {
  // 只打印尺寸大的（占满画面的那个）
  const maxDim = Math.max(...it.size)
  if (maxDim > 50 || it.type === 'Mesh') {
    console.log(`${it.type.padEnd(14)} ${it.name.padEnd(22)} visible=${it.visible} size=${JSON.stringify(it.size)} center=${JSON.stringify(it.center)}`)
  }
}
await browser.close(); server.close()
