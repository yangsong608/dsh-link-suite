/**
 * 准入闸门自检：建连限额、速率、帧上限、Origin。
 *
 * 这些全部在**认证之前**执行，所以它们错了不会表现为"权限漏洞"，
 * 而是表现为"局域网里一个脚本就能把宿主打爆"。这类问题很难在功能测试里发现。
 */

import assert from 'node:assert/strict'

import {
  AdmissionControl,
  checkOrigin,
  CONNECT_RATE_PER_MIN,
  MAX_CONN_PER_IP,
  MAX_CONN_TOTAL,
  defaultAllowedOrigins,
} from '../lib/gateway/limits.js'
import { MAX_CONTROL_FRAME_BYTES } from '@dsh-link/protocol'

let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

test('正常连接可以被接纳并归还额度', () => {
  const ac = new AdmissionControl()
  assert.equal(ac.admitConnection('10.0.0.1').ok, true)
  assert.equal(ac.total, 1)
  ac.releaseConnection('10.0.0.1')
  assert.equal(ac.total, 0)
})

test('单 IP 并发上限生效', () => {
  const ac = new AdmissionControl()
  for (let i = 0; i < MAX_CONN_PER_IP; i++) {
    assert.equal(ac.admitConnection('10.0.0.2').ok, true, `第 ${i + 1} 条连接应被接纳`)
  }
  const denied = ac.admitConnection('10.0.0.2')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 429)
  assert.match(denied.reason, /this address/)
})

test('全局并发上限生效', () => {
  const ac = new AdmissionControl()
  let admitted = 0
  // 每个 IP 只占 1 条，绕开单 IP 限制，验证全局上限
  for (let i = 0; admitted < MAX_CONN_TOTAL; i++) {
    const verdict = ac.admitConnection(`10.1.${String(Math.floor(i / 200))}.${String(i % 200)}`, 0)
    if (verdict.ok) admitted++
    else break
  }
  assert.equal(ac.total, MAX_CONN_TOTAL)
  const extra = ac.admitConnection('192.168.9.9', 0)
  assert.equal(extra.ok, false)
  assert.match(extra.reason, /too many connections$/)
})

test('建连速率限制生效（同一 IP 快速连开）', () => {
  const ac = new AdmissionControl()
  // 速率桶容量 = CONNECT_RATE_PER_MIN；先到上限
  for (let i = 0; i < CONNECT_RATE_PER_MIN; i++) {
    const verdict = ac.admitConnection('10.0.0.3', 1_000)
    assert.equal(verdict.ok, true, `第 ${i + 1} 次应放行`)
    ac.releaseConnection('10.0.0.3')
  }
  const denied = ac.admitConnection('10.0.0.3', 1_001)
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /rate/)
})

test('速率桶按分钟补充', () => {
  const ac = new AdmissionControl()
  for (let i = 0; i < CONNECT_RATE_PER_MIN; i++) {
    ac.admitConnection('10.0.0.4', 1_000)
    ac.releaseConnection('10.0.0.4')
  }
  assert.equal(ac.admitConnection('10.0.0.4', 1_500).ok, false)
  // 过了一分钟，桶补充一次
  assert.equal(ac.admitConnection('10.0.0.4', 61_500).ok, true)
})

test('归还不会把额度还成负数（幂等）', () => {
  const ac = new AdmissionControl()
  ac.admitConnection('10.0.0.5')
  ac.releaseConnection('10.0.0.5')
  ac.releaseConnection('10.0.0.5')
  assert.equal(ac.total, 0)
})

test('帧上限：256KiB 以内放行，超出拒绝', () => {
  const ac = new AdmissionControl()
  assert.equal(ac.checkFrame(MAX_CONTROL_FRAME_BYTES).ok, true)
  const denied = ac.checkFrame(MAX_CONTROL_FRAME_BYTES + 1)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 413)
})

test('Origin：同源（Host 一致）放行', () => {
  assert.equal(checkOrigin('http://192.168.1.10:7443', [], '192.168.1.10:7443'), true)
})

test('Origin：不带 Origin 的客户端放行（curl / 原生 App）', () => {
  assert.equal(checkOrigin(undefined, [], '192.168.1.10:7443'), true)
  assert.equal(checkOrigin('', [], '192.168.1.10:7443'), true)
})

test('Origin：跨站来源拒绝（WebSocket 不受 CORS 约束，这条是实际攻击面）', () => {
  assert.equal(checkOrigin('https://evil.example', [], '192.168.1.10:7443'), false)
})

test('Origin：白名单里的来源放行（反代 / dsh 自定义域名）', () => {
  assert.equal(
    checkOrigin('https://dsh.example.com', ['https://dsh.example.com'], '192.168.1.10:7443'),
    true,
  )
})

test('Origin：白名单比较忽略尾部斜杠', () => {
  assert.equal(checkOrigin('https://dsh.example.com/', ['https://dsh.example.com'], 'other'), true)
})

test('Origin：畸形 Origin 按拒绝处理（不能靠制造解析异常绕过）', () => {
  assert.equal(checkOrigin('not a url', [], '192.168.1.10:7443'), false)
})

test('回环来源默认在白名单里', () => {
  const allowed = defaultAllowedOrigins()
  assert.ok(allowed.some((o) => o.includes('127.0.0.1')))
  assert.ok(allowed.some((o) => o.includes('localhost')))
})

console.log(`\n${passed} passed`)
