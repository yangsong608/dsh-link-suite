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

const a = await page.evaluate(()=>window.__render({width:640,height:640,yaw:0,pitch:0,working:false,format:'png'}))
console.log('第1次 渲染计数:', await page.evaluate(()=>window.__renderCalls()), '长度:', String(a).length)
const b = await page.evaluate(()=>window.__render({width:640,height:640,yaw:60,pitch:20,working:false,format:'png'}))
console.log('第2次 渲染计数:', await page.evaluate(()=>window.__renderCalls()), '长度:', String(b).length)
console.log('两次结果相同:', String(a)===String(b))
await browser.close(); server.close()
