// 探针：起一个最小网关，验证 upgrade 的 Origin/令牌/限速闸门顺序是否正确
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const http = createServer((req, res) => { res.writeHead(200); res.end('ok') })
const wss = new WebSocketServer({ server: http, path: '/dshlink' })

let upgradeChecked = 0
http.on('upgrade', (req, socket) => {
  upgradeChecked += 1
  const origin = req.headers.origin
  if (origin === 'https://evil.example') {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
})

wss.on('connection', (ws) => { ws.send('hello'); ws.close() })

await new Promise((r) => http.listen(0, '127.0.0.1', r))
const port = http.address().port
console.log('probe listening', port, 'upgradeChecked', upgradeChecked)
