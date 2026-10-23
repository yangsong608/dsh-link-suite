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
// 首渲 + 两次不同角度，读相机位置
await page.evaluate(()=>window.__render({width:640,height:640,yaw:0,pitch:0}))
const a = await page.evaluate(()=>window.__camPos ? window.__camPos() : 'no probe')
await page.evaluate(()=>window.__render({width:640,height:640,yaw:60,pitch:20}))
const b = await page.evaluate(()=>window.__camPos ? window.__camPos() : 'no probe')
console.log('第一次相机:', JSON.stringify(a))
console.log('第二次相机:', JSON.stringify(b))
console.log('是否相同:', JSON.stringify(a)===JSON.stringify(b))
await browser.close(); server.close()
