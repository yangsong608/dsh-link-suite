/**
 * 附件上传里最容易出错的环节是 base64 解码：
 * 大文件整串 atob 会爆栈、带 data: 前缀会解出垃圾。
 */
import assert from 'node:assert/strict'
import { decodeBase64ForTest } from '../lib/gateway/router.js'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log('  ok  ' + name) }

await test('普通 base64 解码正确', () => {
  const bytes = decodeBase64ForTest(Buffer.from('hello world').toString('base64'))
  assert.equal(Buffer.from(bytes).toString(), 'hello world')
})

await test('带 data: 前缀也能解（前端常直接传整串）', () => {
  const bytes = decodeBase64ForTest('data:image/png;base64,' + Buffer.from('PNG!').toString('base64'))
  assert.equal(Buffer.from(bytes).toString(), 'PNG!')
})

await test('大文件分块解码不爆栈（1MB）', () => {
  const big = Buffer.alloc(1024 * 1024, 7)
  const bytes = decodeBase64ForTest(big.toString('base64'))
  assert.equal(bytes.byteLength, big.length)
  assert.equal(bytes[0], 7)
  assert.equal(bytes[bytes.length - 1], 7)
})

await test('空串解出空数组', () => {
  assert.equal(decodeBase64ForTest('').byteLength, 0)
})

console.log(`\n${passed} passed`)
