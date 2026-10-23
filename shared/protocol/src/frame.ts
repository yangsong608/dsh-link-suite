/**
 * 帧编解码。
 *
 * 控制帧走 JSON（可调试优先），二进制帧走定长头（吞吐优先）。
 * 加密不在本文件：它包在更外层（见 docs/02-技术方案.md §4.4），
 * 这样"帧长什么样"可以脱开密码学单独测试。
 */

import type { Method } from './methods.js'
import type { RpcErrorShape } from './errors.js'

/** 单帧上限 256 KiB。超过必须走二进制通道，否则一次大 payload 会卡住多路复用的其它通道。 */
export const MAX_CONTROL_FRAME_BYTES = 256 * 1024

/** 二进制块默认大小（上传并发 2 路 × 512KiB，见技术方案 §10）。 */
export const CHUNK_BYTES = 512 * 1024

export interface ReqFrame {
  t: 'req'
  id: number
  m: Method | string
  p?: unknown
}

export interface ResOkFrame {
  t: 'res'
  id: number
  ok: true
  r?: unknown
}

export interface ResErrFrame {
  t: 'res'
  id: number
  ok: false
  e: RpcErrorShape
}

export interface EvtFrame {
  t: 'evt'
  /** 逻辑通道：`sess:<id>`、`fs:<id>`、`term:<id>`、`ctl` */
  ch: string
  /** 每通道独立单调递增，用于断线续播与去重 */
  seq: number
  m: string
  p?: unknown
}

export interface PingFrame {
  t: 'ping'
  ts: number
}

export interface PongFrame {
  t: 'pong'
  ts: number
}

export interface ByeFrame {
  t: 'bye'
  code: string
  msg?: string
}

export type Frame =
  | ReqFrame
  | ResOkFrame
  | ResErrFrame
  | EvtFrame
  | PingFrame
  | PongFrame
  | ByeFrame

/** 二进制帧类别。首字节固定，便于在不解析负载的情况下分流。 */
export const BIN_FILE = 0x01
export const BIN_TERM = 0x02

export interface FileChunk {
  kind: 'file'
  chId: number
  offset: number
  payload: Uint8Array
}

export interface TermChunk {
  kind: 'term'
  chId: number
  payload: Uint8Array
}

export type BinaryFrame = FileChunk | TermChunk

// ── 控制帧 ────────────────────────────────────────────────────────────────

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}

/**
 * 解析控制帧。刻意宽松（未知 `t` 直接抛），刻意严格（不认识的字段原样保留在对象里，
 * 便于向前兼容时客户端忽略）。
 */
export function decodeFrame(raw: string): Frame {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('frame: not JSON')
  }
  if (typeof value !== 'object' || value === null) throw new Error('frame: not an object')
  const t = (value as { t?: unknown }).t
  switch (t) {
    case 'req': {
      const f = value as Partial<ReqFrame>
      if (typeof f.id !== 'number' || typeof f.m !== 'string') throw new Error('frame: bad req')
      return f as ReqFrame
    }
    case 'res': {
      // 注意不要写 `Partial<ResOkFrame & ResErrFrame>`：`ok: true & false` 会收窄成 never。
      const f = value as { id?: unknown; ok?: unknown }
      if (typeof f.id !== 'number' || typeof f.ok !== 'boolean') throw new Error('frame: bad res')
      return value as ResOkFrame | ResErrFrame
    }
    case 'evt': {
      const f = value as Partial<EvtFrame>
      if (typeof f.ch !== 'string' || typeof f.seq !== 'number' || typeof f.m !== 'string') {
        throw new Error('frame: bad evt')
      }
      return f as EvtFrame
    }
    case 'ping':
      return { t: 'ping', ts: typeof (value as PingFrame).ts === 'number' ? (value as PingFrame).ts : 0 }
    case 'pong':
      return { t: 'pong', ts: typeof (value as PongFrame).ts === 'number' ? (value as PongFrame).ts : 0 }
    case 'bye': {
      const f = value as Partial<ByeFrame>
      return { t: 'bye', code: typeof f.code === 'string' ? f.code : 'unknown' }
    }
    default:
      throw new Error(`frame: unknown type ${String(t)}`)
  }
}

/** 控制帧是否超限（加密前判断，避免白干一次 AEAD）。 */
export function frameBytes(frame: Frame): number {
  return new TextEncoder().encode(encodeFrame(frame)).byteLength
}

// ── 二进制帧 ──────────────────────────────────────────────────────────────

/** `[kind:1][chId:4][offset:8][payload]` —— 文件块 */
export function encodeFileChunk(chunk: FileChunk): Uint8Array {
  const out = new Uint8Array(13 + chunk.payload.byteLength)
  const view = new DataView(out.buffer)
  out[0] = BIN_FILE
  view.setUint32(1, chunk.chId, false)
  view.setBigUint64(5, BigInt(chunk.offset), false)
  out.set(chunk.payload, 13)
  return out
}

/** `[kind:1][chId:4][payload]` —— 终端字节流 */
export function encodeTermChunk(chunk: TermChunk): Uint8Array {
  const out = new Uint8Array(5 + chunk.payload.byteLength)
  const view = new DataView(out.buffer)
  out[0] = BIN_TERM
  view.setUint32(1, chunk.chId, false)
  out.set(chunk.payload, 5)
  return out
}

export function decodeBinary(buf: Uint8Array): BinaryFrame {
  if (buf.byteLength < 5) throw new Error('bin: too short')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const kind = buf[0]
  if (kind === BIN_FILE) {
    if (buf.byteLength < 13) throw new Error('bin: bad file header')
    return {
      kind: 'file',
      chId: view.getUint32(1, false),
      offset: Number(view.getBigUint64(5, false)),
      payload: buf.subarray(13),
    }
  }
  if (kind === BIN_TERM) {
    return { kind: 'term', chId: view.getUint32(1, false), payload: buf.subarray(5) }
  }
  throw new Error(`bin: unknown kind ${String(kind)}`)
}

// ── 帧序号（每通道独立） ──────────────────────────────────────────────────

/**
 * 每通道独立的序号发生器。断线重连时客户端带 `from` 上来，宿主据此决定补播还是要求重同步。
 * 装在协议包里是因为两侧都要用，且这是最容易被写错状态的地方。
 */
export class SeqCounter {
  #next = 0

  next(): number {
    return this.#next++
  }

  get current(): number {
    return this.#next
  }

  /** 从上游游标继续（续播时用），只能前进不能后退。 */
  reset(from: number): void {
    this.#next = Math.max(this.#next, from)
  }
}

/** 判断一个事件帧是否应被丢弃（重复或过期）。续播窗口只接受 > lastSeen 的序号。 */
export function shouldDeliver(seq: number, lastSeen: number): boolean {
  return seq > lastSeen
}
