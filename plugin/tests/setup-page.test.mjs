/**
 * 设置页自检。
 *
 * 这个页面是"只有接口、没有入口"那类问题的修复，所以测试的重点不是样式，
 * 而是：页面必须真的出现关键控件、地址必须真的填进去、以及 XSS 边界。
 */

import assert from 'node:assert/strict'

import { renderSetupPage } from '../lib/setup-page.js'

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`) }

const html = renderSetupPage('h_test_123', ['ws://192.168.1.5:7443/dshlink', 'ws://10.0.0.2:7443/dshlink'], 7443)

test('页面包含三个必需区块：锁屏 / 配对 / 设备', () => {
  assert.match(html, /锁屏密码/)
  assert.match(html, /配对新设备/)
  assert.match(html, /已配对设备/)
})

test('展示手机应填的连接地址（用户不该自己去查 ifconfig）', () => {
  assert.ok(html.includes('ws://192.168.1.5:7443/dshlink'))
  assert.ok(html.includes('ws://10.0.0.2:7443/dshlink'))
})

test('没有局域网地址时给出明确提示，而不是空白', () => {
  const empty = renderSetupPage('h', [], 7443)
  assert.match(empty, /没有检测到局域网地址/)
})

test('主机 id 与端口出现在页面上（排障时第一个要看的两个值）', () => {
  assert.ok(html.includes('h_test_123'))
  assert.match(html, /7443/)
})

test('关键控件齐全（有按钮才能"用得到"）', () => {
  for (const id of ['pw-save', 'pw-lock', 'pw-clear', 'pair-start', 'status', 'devices']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`)
  }
})

test('页面不内联任何密钥或令牌', () => {
  assert.equal(/token|password"\s*:\s*"/.test(html.replace(/type="password"/g, '')), false)
})

test('主机 id 会被转义（防止注入到 HTML 属性里）', () => {
  const evil = renderSetupPage('<img src=x onerror=alert(1)>', [], 7443)
  assert.equal(evil.includes('<img src=x'), false, 'hostId 必须被转义')
  assert.ok(evil.includes('&lt;img'))
})

console.log(`\n${passed} passed`)
