/**
 * 配对 URI 自检。
 *
 * 这个格式是 PC 与 App 之间的**跨设备契约**：PC 生成、手机解析。
 * 两侧不能共用代码时（App 用 TS 源码、PC 用编译产物），
 * 格式错误只会表现为"扫码后连不上"，很难排查。所以这里把
 * 往返、边界与错误分类都锁住。
 */

import assert from 'node:assert/strict'

import {
  encodePairUri,
  decodePairUri,
  pairPayloadFromEndpoint,
  PAIR_SCHEME,
} from '../dist/pairing.js'

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`) }

test('往返：编码再解码得到原始字段', () => {
  const uri = encodePairUri({
    host: '192.168.1.23',
    port: 7443,
    code: '482913',
    version: 1,
    secure: false,
    fingerprint: 'a1b2c3',
  })
  const out = decodePairUri(uri)
  assert.equal(out.ok, true)
  assert.equal(out.payload.host, '192.168.1.23')
  assert.equal(out.payload.port, 7443)
  assert.equal(out.payload.code, '482913')
  assert.equal(out.payload.secure, false)
  assert.equal(out.payload.fingerprint, 'a1b2c3')
  assert.equal(out.wsUrl, 'ws://192.168.1.23:7443/dshlink')
})

test('TLS 时生成 wss://', () => {
  const uri = encodePairUri({ host: 'dsh.example.com', port: 443, code: '111111', version: 1, secure: true })
  const out = decodePairUri(uri)
  assert.equal(out.ok, true)
  assert.equal(out.wsUrl, 'wss://dsh.example.com:443/dshlink')
})

test('自定义路径（反代场景）', () => {
  const uri = encodePairUri({
    host: 'dsh.example.com', port: 7443, code: '222222', version: 1, secure: true, path: '/link/ws',
  })
  const out = decodePairUri(uri)
  assert.equal(out.ok, true)
  assert.equal(out.wsUrl, 'wss://dsh.example.com:7443/link/ws')
})

test('扫到非配对码时明确区分（不是静默失败）', () => {
  assert.equal(decodePairUri('https://example.com').reason, 'not-pair-uri')
  assert.equal(decodePairUri('随便一段文字').reason, 'not-pair-uri')
  assert.equal(decodePairUri('').reason, 'not-pair-uri')
})

test('字段缺失/非法时给出具体原因', () => {
  assert.equal(decodePairUri(`${PAIR_SCHEME}://pair?p=7443&c=123456&v=1`).reason, 'missing-host')
  assert.equal(decodePairUri(`${PAIR_SCHEME}://pair?h=a&p=abc&c=123456`).reason, 'bad-port')
  assert.equal(decodePairUri(`${PAIR_SCHEME}://pair?h=a&p=7443&c=12`).reason, 'bad-code')
  assert.equal(decodePairUri(`${PAIR_SCHEME}://pair?h=a&p=70000&c=123456`).reason, 'bad-port')
})

test('配对码必须是 6 位数字', () => {
  assert.equal(decodePairUri(`${PAIR_SCHEME}://pair?h=a&p=7443&c=abcdef`).reason, 'bad-code')
  assert.equal(decodePairUri(`${PAIR_SCHEME}://pair?h=a&p=7443&c=1234567`).reason, 'bad-code')
})

test('URI 不含任何秘密（只有地址与短期码）', () => {
  const uri = encodePairUri({ host: '10.0.0.5', port: 7443, code: '999999', version: 1, secure: false })
  assert.equal(/token|password|secret|key/i.test(uri), false, '不允许出现凭证类字段')
})

test('从 ws 地址反推二维码字段', () => {
  const payload = pairPayloadFromEndpoint('ws://172.80.2.178:7443/dshlink', '333333', 'ff00ff')
  assert.ok(payload)
  assert.equal(payload.host, '172.80.2.178')
  assert.equal(payload.port, 7443)
  assert.equal(payload.secure, false)
  assert.equal(payload.path, '/dshlink')
  assert.equal(payload.fingerprint, 'ff00ff')
})

test('从 wss 地址反推时标记 secure', () => {
  const payload = pairPayloadFromEndpoint('wss://dsh.example.com/dshlink', '444444')
  assert.ok(payload)
  assert.equal(payload.secure, true)
  assert.equal(payload.port, 443, '未写端口时 wss 默认 443')
})

test('非法 ws 地址返回 undefined', () => {
  assert.equal(pairPayloadFromEndpoint('不是地址', '555555'), undefined)
})

test('二维码内容长度可控（版本不会爆炸）', () => {
  const uri = encodePairUri({
    host: '192.168.100.200', port: 65535, code: '123456', version: 1, secure: true, fingerprint: 'abcdef',
  })
  assert.ok(uri.length < 90, `配对 URI 应足够短便于扫描，实际 ${uri.length}`)
})

console.log(`\n${passed} passed`)
