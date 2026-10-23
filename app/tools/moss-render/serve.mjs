import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
const ROOT = '/Volumes/软件目录/work/zkxh/deepseek/dsh-link-suite/app/dist/build/h5'
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2' }
const server = createServer(async (req, res) => {
  let u = decodeURIComponent((req.url ?? '/').split('?')[0])
  if (u === '/') u = '/index.html'
  try {
    const b = await readFile(join(ROOT, u))
    res.writeHead(200, { 'content-type': MIME[extname(u)] ?? 'application/octet-stream' })
    res.end(b)
  } catch { res.writeHead(404); res.end('nf') }
})
server.listen(5188, '127.0.0.1', () => console.log('H5 on http://127.0.0.1:5188'))
