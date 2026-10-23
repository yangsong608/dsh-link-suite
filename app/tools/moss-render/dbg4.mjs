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

// 直接读 canvas 的像素指纹（不用 toDataURL）
const fps = await page.evaluate(async () => {
  const canvas = document.getElementById('stage')
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  const grab = () => {
    const w = canvas.width, h = canvas.height
    const px = new Uint8Array(w*h*4)
    gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px)
    let sum = 0
    for (let i=0;i<px.length;i+=4) sum += px[i] + px[i+1]*3 + px[i+2]*7
    return { w, h, sum }
  }
  await window.__render({width:640,height:640,yaw:0,pitch:0,format:'png'})
  const a = grab()
  await window.__render({width:640,height:640,yaw:75,pitch:25,format:'png'})
  const b = grab()
  return { a, b, same: a.sum === b.sum }
})
console.log('canvas 尺寸/像素和 A:', JSON.stringify(fps.a))
console.log('canvas 尺寸/像素和 B:', JSON.stringify(fps.b))
console.log('像素和相同:', fps.same)
await browser.close(); server.close()
