/**
 * 极简二维码编码器（字节模式，纠错等级 M）。
 *
 * 为什么自己写而不是引 qrcode-generator：
 *   1. 插件依赖面越小，dsh 升级时重新验证的成本越低（本项目只有 ws 一个真实依赖）
 *   2. 配对二维码的内容只有几十字节（`dshlink://pair?...`），用不到完整实现
 *   3. 纯函数、可单测——二维码是"生成错了就扫不出来"的东西，必须能验证
 *
 * 只实现必要路径：
 *   - 字节模式（UTF-8），不写数字/字母数字模式的优化
 *   - 版本 1–10（最长约 213 字节，配对串远小于此）
 *   - 纠错等级 M（15% 冗余，容错与容量的平衡点）
 *   - 标准掩码选择（8 种都算，取惩罚分最低的）
 *
 * 不支持的输入直接抛错，而不是生成一个扫不出来的码——静默出错比拒绝更糟。
 */

/** 每个版本的容量表（纠错 M）：[数据码字数, 纠错码字数, 块数] */
const CAPACITY_M: Record<number, { data: number; ecc: number; blocks: number }> = {
  1: { data: 16, ecc: 10, blocks: 1 },
  2: { data: 28, ecc: 16, blocks: 1 },
  3: { data: 44, ecc: 26, blocks: 1 },
  4: { data: 64, ecc: 18, blocks: 2 },
  5: { data: 86, ecc: 24, blocks: 2 },
  6: { data: 108, ecc: 16, blocks: 4 },
  7: { data: 124, ecc: 18, blocks: 4 },
  8: { data: 154, ecc: 22, blocks: 2 },
  9: { data: 182, ecc: 22, blocks: 3 },
  10: { data: 216, ecc: 26, blocks: 4 },
}

/** 对齐图案中心坐标（版本 → 坐标列表） */
const ALIGN: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
}

// ── GF(256) 与 Reed-Solomon ────────────────────────────────────────────────

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0
})()

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0
}

/** 生成多项式 g(x) = ∏(x - α^i) */
function rsPoly(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ (poly[j] ?? 0)
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j] ?? 0, EXP[i] ?? 0)
    }
    poly = next
  }
  return poly
}

/** 计算纠错码字 */
function rsEncode(data: number[], eccCount: number): number[] {
  const gen = rsPoly(eccCount)
  const buf = [...data, ...new Array<number>(eccCount).fill(0)]
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i] ?? 0
    if (coef === 0) continue
    for (let j = 0; j < gen.length; j++) {
      buf[i + j] = (buf[i + j] ?? 0) ^ gfMul(gen[j] ?? 0, coef)
    }
  }
  return buf.slice(data.length)
}

// ── 位流 ──────────────────────────────────────────────────────────────────

class BitBuffer {
  readonly bits: number[] = []

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1)
  }

  get length(): number {
    return this.bits.length
  }

  /** 补齐到 8 的倍数 */
  padToByte(): void {
    while (this.bits.length % 8 !== 0) this.bits.push(0)
  }
}

// ── 编码 ──────────────────────────────────────────────────────────────────

export interface QrMatrix {
  /** 模块数（边长） */
  readonly size: number
  /** size × size，true = 黑 */
  readonly modules: readonly (readonly boolean[])[]
  /** 使用的版本，便于调试 */
  readonly version: number
}

function pickVersion(byteLength: number): number {
  for (let v = 1; v <= 10; v++) {
    const cap = CAPACITY_M[v]!
    // 4 位模式 + 8/16 位长度 + 数据
    const overhead = v <= 9 ? 12 : 20
    if (byteLength * 8 + overhead <= cap.data * 8) return v
  }
  throw new Error(`qrcode: 内容过长（${String(byteLength)} 字节），最大支持约 213 字节`)
}

function utf8Bytes(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    }
  }
  return out
}

/** 把数据码字按块交织（版本 ≥4 有多块） */
function interleave(data: number[], version: number): number[] {
  const { blocks, ecc } = CAPACITY_M[version]!
  const dataLen = CAPACITY_M[version]!.data
  const perBlock = Math.floor(dataLen / blocks)
  const remainder = dataLen % blocks

  const dataBlocks: number[][] = []
  let offset = 0
  for (let b = 0; b < blocks; b++) {
    const len = perBlock + (b < remainder ? 1 : 0)
    dataBlocks.push(data.slice(offset, offset + len))
    offset += len
  }

  const eccBlocks = dataBlocks.map((blk) => rsEncode(blk, ecc))

  const out: number[] = []
  const maxLen = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < maxLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) out.push(blk[i]!)
    }
  }
  for (let i = 0; i < ecc; i++) {
    for (const blk of eccBlocks) out.push(blk[i]!)
  }
  return out
}

/** 功能图案（定位、对齐、时序、格式区）占位表 */
function createReserved(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
}

function placeFinder(m: boolean[][], r: number, c: number, reserved: boolean[][]): void {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr
      const cc = c + dc
      if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue
      const inRing =
        (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
        (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6))
      const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
      m[rr]![cc] = inRing || inCore
      reserved[rr]![cc] = true
    }
  }
}

function placeAlignment(m: boolean[][], size: number, version: number, reserved: boolean[][]): void {
  const centers = ALIGN[version]!
  for (const r of centers) {
    for (const c of centers) {
      // 与三个定位图案重叠的位置跳过
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)
      if (nearFinder) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
          m[r + dr]![c + dc] = dark
          reserved[r + dr]![c + dc] = true
        }
      }
    }
  }
}

function placeTiming(m: boolean[][], size: number, reserved: boolean[][]): void {
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0
    m[6]![i] = dark
    reserved[6]![i] = true
    m[i]![6] = dark
    reserved[i]![6] = true
  }
}

function placeFormat(m: boolean[][], size: number, mask: number, reserved: boolean[][]): void {
  // 纠错等级 M 的两位编码是 00
  const eccBits = 0b00
  const data = (eccBits << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412

  // 左上
  for (let i = 0; i <= 5; i++) {
    m[8]![i] = ((bits >>> i) & 1) === 1
    reserved[8]![i] = true
  }
  m[8]![7] = ((bits >>> 6) & 1) === 1
  m[8]![8] = ((bits >>> 7) & 1) === 1
  m[7]![8] = ((bits >>> 8) & 1) === 1
  for (let i = 9; i <= 14; i++) {
    const row = 14 - i
    m[row]![8] = ((bits >>> i) & 1) === 1
    reserved[row]![8] = true
  }
  // 右上 + 左下
  for (let i = 0; i <= 7; i++) {
    m[8]![size - 1 - i] = ((bits >>> i) & 1) === 1
    reserved[8]![size - 1 - i] = true
  }
  for (let i = 8; i <= 14; i++) {
    m[size - 15 + i]![8] = ((bits >>> i) & 1) === 1
    reserved[size - 15 + i]![8] = true
  }
  // 固定为黑的模块
  m[size - 8]![8] = true
  reserved[size - 8]![8] = true
}

/** 8 种掩码函数 */
const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

/** 掩码惩罚分：用于挑出最好扫的那一个 */
function penalty(m: boolean[][]): number {
  const size = m.length
  let score = 0

  const scoreLine = (get: (i: number) => boolean): void => {
    let run = 1
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) run++
      else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
    }
    if (run >= 5) score += 3 + (run - 5)
  }

  for (let r = 0; r < size; r++) scoreLine((i) => m[r]![i]!)
  for (let c = 0; c < size; c++) scoreLine((i) => m[i]![c]!)

  // 2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r]![c]
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3
    }
  }

  // 2×2 同色块 + 类定位图案（1:1:3:1:1）
  const pattern = [true, false, true, true, true, false, true]
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 7; c++) {
      let hit = true
      for (let k = 0; k < 7; k++) {
        if (m[r]![c + k] !== pattern[k]) {
          hit = false
          break
        }
      }
      if (hit) score += 40
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r <= size - 7; r++) {
      let hit = true
      for (let k = 0; k < 7; k++) {
        if (m[r + k]![c] !== pattern[k]) {
          hit = false
          break
        }
      }
      if (hit) score += 40
    }
  }

  // 黑白比例偏离 50%
  let dark = 0
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r]![c]) dark++
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10
  return score
}

/** 生成二维码矩阵。 */
export function encodeQr(text: string): QrMatrix {
  const bytes = utf8Bytes(text)
  if (bytes.length === 0) throw new Error('qrcode: 内容不能为空')
  const version = pickVersion(bytes.length)
  const cap = CAPACITY_M[version]!
  const size = 17 + version * 4

  // ① 位流：模式(4) + 长度(8/16) + 数据 + 终止符 + 填充
  const buf = new BitBuffer()
  buf.put(0b0100, 4)
  buf.put(bytes.length, version <= 9 ? 8 : 16)
  for (const b of bytes) buf.put(b, 8)
  const maxBits = cap.data * 8
  const terminator = Math.min(4, maxBits - buf.length)
  buf.put(0, terminator)
  buf.padToByte()
  // 交替填充 0xEC / 0x11 直到填满数据容量
  let pad = 0
  const padBytes = [0xec, 0x11]
  while (buf.length < maxBits) {
    buf.put(padBytes[pad % 2]!, 8)
    pad++
  }

  const dataBytes: number[] = []
  for (let i = 0; i < buf.bits.length; i += 8) {
    let v = 0
    for (let k = 0; k < 8; k++) v = (v << 1) | (buf.bits[i + k] ?? 0)
    dataBytes.push(v)
  }

  // ② 纠错 + 交织
  const finalBytes = interleave(dataBytes, version)

  // ③ 功能图案
  const m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const reserved = createReserved(size)
  placeFinder(m, 0, 0, reserved)
  placeFinder(m, 0, size - 7, reserved)
  placeFinder(m, size - 7, 0, reserved)
  placeAlignment(m, size, version, reserved)
  placeTiming(m, size, reserved)
  placeFormat(m, size, 0, reserved) // 先占位，选好掩码后重写

  // ④ 数据放置（右→左、上下交替）
  const bits: number[] = []
  for (const byte of finalBytes) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1)
  let bitIndex = 0
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col-- // 跳过时序列
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (let k = 0; k < 2; k++) {
        const c = col - k
        if (reserved[row]![c]) continue
        const bit = bitIndex < bits.length ? bits[bitIndex]! : 0
        bitIndex++
        m[row]![c] = bit === 1
      }
    }
    upward = !upward
  }

  // ⑤ 选掩码：8 种都试，取惩罚分最低的
  let best = { mask: 0, score: Number.POSITIVE_INFINITY }
  for (let mask = 0; mask < 8; mask++) {
    const candidate = m.map((row) => [...row])
    const res = createReserved(size)
    placeFinder(candidate, 0, 0, res)
    placeFinder(candidate, 0, size - 7, res)
    placeFinder(candidate, size - 7, 0, res)
    placeAlignment(candidate, size, version, res)
    placeTiming(candidate, size, res)
    placeFormat(candidate, size, mask, res)

    const fn = MASKS[mask]!
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (reserved[r]![c]) continue
        if (fn(r, c)) candidate[r]![c] = !candidate[r]![c]
      }
    }
    const score = penalty(candidate)
    if (score < best.score) best = { mask, score }
  }

  // ⑥ 用最优掩码重画一遍
  const out = m.map((row) => [...row])
  const res = createReserved(size)
  placeFinder(out, 0, 0, res)
  placeFinder(out, 0, size - 7, res)
  placeFinder(out, size - 7, 0, res)
  placeAlignment(out, size, version, res)
  placeTiming(out, size, res)
  placeFormat(out, size, best.mask, res)
  const fn = MASKS[best.mask]!
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r]![c]) continue
      if (fn(r, c)) out[r]![c] = !out[r]![c]
    }
  }

  return { size, modules: out, version }
}
