/**
 * 二维码编码器自检。
 *
 * 二维码的特性是"生成错了，只有扫不出来才知道"——不像别的函数，
 * 肉眼也能看出返回值不对。所以这组测试的重点是**结构与已知常量**：
 *   1. 定位图案、时序、对齐图案的位置必须符合规范
 *   2. 同一输入必须得到同一输出（纯函数）
 *   3. 版本选择与容量边界
 *   4. 与参考实现的一致性，通过"用系统解码器读回"验证（见 verify-qr.sh）
 *
 * 真正的端到端验证在 test 里跑一次 Vision 解码（仅 macOS），
 * 失败时跳过而不是报错——CI 在 Linux 上没有 Vision。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encodeQr } from '../dist/qr.js'

let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

const SAMPLE = 'dshlink://pair?h=192.168.1.23&p=7443&c=482913'

test('输出尺寸符合 17 + 4×版本', () => {
  const qr = encodeQr(SAMPLE)
  assert.equal(qr.size, 17 + 4 * qr.version)
  assert.equal(qr.modules.length, qr.size)
  assert.equal(qr.modules[0].length, qr.size)
})

test('纯函数：同输入同输出', () => {
  const a = encodeQr(SAMPLE)
  const b = encodeQr(SAMPLE)
  assert.deepEqual(a.modules, b.modules)
})

test('三个定位图案存在（7×7 的方环 + 中心块）', () => {
  const qr = encodeQr(SAMPLE)
  const m = qr.modules
  const corners = [
    [0, 0],
    [0, qr.size - 7],
    [qr.size - 7, 0],
  ]
  const at = (r, c) => m[r][c] === true

  for (const [r0, c0] of corners) {
    // 外环
    for (let i = 0; i < 7; i++) {
      assert.ok(at(r0, c0 + i), `外环上边 (${r0},${c0 + i})`)
      assert.ok(at(r0 + 6, c0 + i), `外环下边`)
      assert.ok(at(r0 + i, c0), `外环左边`)
      assert.ok(at(r0 + i, c0 + 6), `外环右边`)
    }
    // 中心 3×3
    for (let dr = 2; dr <= 4; dr++) {
      for (let dc = 2; dc <= 4; dc++) {
        assert.ok(at(r0 + dr, c0 + dc), `中心块 (${r0 + dr},${c0 + dc})`)
      }
    }
    // 内外环之间的白圈
    assert.equal(at(r0 + 1, c0 + 1), false, '定位图案内圈必须是白的')
  }
})

test('时序图案在第 6 行/列交替', () => {
  const qr = encodeQr(SAMPLE)
  for (let i = 8; i < qr.size - 8; i++) {
    assert.equal(qr.modules[6][i], i % 2 === 0, `第 6 行第 ${i} 列`)
    assert.equal(qr.modules[i][6], i % 2 === 0, `第 6 列第 ${i} 行`)
  }
})

test('右下角固定黑模块存在（暗模块）', () => {
  const qr = encodeQr(SAMPLE)
  assert.equal(qr.modules[qr.size - 8][8], true, '固定暗模块必须为黑')
})

test('短内容用低版本，长内容升版本', () => {
  const short = encodeQr('hi')
  const long = encodeQr('x'.repeat(100))
  assert.ok(short.version < long.version, `短内容版本应更小：${short.version} vs ${long.version}`)
})

test('超长内容明确抛错（而不是生成扫不出的码）', () => {
  assert.throws(() => encodeQr('x'.repeat(400)), /内容过长/)
})

test('空内容抛错', () => {
  assert.throws(() => encodeQr(''), /不能为空/)
})

test('UTF-8 中文可用（字节模式长度按字节算）', () => {
  const qr = encodeQr('配对码 482913')
  assert.ok(qr.size > 0)
  assert.ok(qr.version >= 1)
})

// 端到端：真正解码一次（仅 macOS 有 Vision 时）
test('用 macOS Vision 解码，读回原文', () => {
  const hasVision = process.platform === 'darwin'
  if (!hasVision) {
    console.log('     （非 macOS，跳过端到端解码）')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'qr-'))
  try {
    const text = SAMPLE
    const qr = encodeQr(text)
    const scale = 6
    const quiet = 4
    const dim = (qr.size + quiet * 2) * scale
    const rows = []
    for (let y = 0; y < dim; y++) {
      let row = ''
      for (let x = 0; x < dim; x++) {
        const mx = Math.floor(x / scale) - quiet
        const my = Math.floor(y / scale) - quiet
        const dark = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size ? qr.modules[my][mx] : false
        row += dark ? '0' : '1'
      }
      rows.push(row)
    }
    const pbm = join(dir, 'q.pbm')
    writeFileSync(pbm, `P1\n${dim} ${dim}\n` + rows.join('\n') + '\n')
    const png = join(dir, 'q.png')
    execFileSync('sips', ['-s', 'format', 'png', pbm, '--out', png], { stdio: 'ignore' })

    const script = `
      ObjC.import("Vision");
      ObjC.import("Foundation");
      const url = $.NSURL.fileURLWithPath("${png}");
      const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $.NSDictionary.dictionary);
      const req = $.VNDetectBarcodesRequest.alloc.init;
      handler.performRequestsError($.NSArray.arrayWithObject(req), $());
      const results = req.results;
      results.count > 0 ? ObjC.unwrap(results.objectAtIndex(0).payloadStringValue) : "FAILED"
    `
    const decoded = execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }).trim()
    assert.equal(decoded, text, `解码结果不符：${decoded}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n${passed} passed`)
