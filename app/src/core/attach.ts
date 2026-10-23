/**
 * 附件：选文件 / 读字节 / 转 base64。
 *
 * 两条路径分开处理，因为它们的成本完全不同：
 *   - 图片：直接内联成 base64 塞进 prompt（dsh 的 content 支持 image 块），
 *     不需要上传，少一次往返。
 *   - 其它文件：必须先走 fs.upload 拿 receiptId，prompt 里用 { type:'file' } 引用。
 *
 * 平台差异集中在 readBase64：
 *   App 端有 FileSystemManager，可以按 path 读；
 *   H5 端拿到的是 blob:/data: URL，只能 fetch 回来再读。
 *   用条件编译分行，避免运行时 if 判断平台字符串（那玩意儿最容易写错）。
 */

export interface PickedFile {
  readonly name: string
  /** 原始字节的 base64（不含 data: 前缀） */
  readonly data: string
  readonly mediaType: string
  readonly bytes: number
}

/** 单附件上限，与服务端 MAX_UPLOAD_BYTES 保持一致。 */
export const MAX_ATTACH_BYTES = 8 * 1024 * 1024

/** 把 ArrayBuffer 转成 base64。分块处理，大文件不会卡死主线程。 */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunk = 8 * 1024
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk)
    // 一次 arguments 展开 8K 个字节是安全的，再大就会爆栈
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

function base64ToBytesLength(base64: string): number {
  const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.floor((clean.length * 3) / 4) - padding
}

/** 按路径/URL 读成 base64（不含前缀）。 */
async function readBase64(path: string): Promise<string> {
  // #ifdef APP-PLUS
  const fs = uni.getFileSystemManager?.()
  if (fs?.readFile !== undefined) {
    return await new Promise<string>((resolve, reject) => {
      fs.readFile({
        filePath: path,
        encoding: 'base64',
        success: (res) => resolve(String(res.data)),
        fail: (err) => reject(new Error(String(err.errMsg ?? '读取失败'))),
      })
    })
  }
  // #endif

  // #ifdef H5
  const res = await fetch(path)
  if (!res.ok) throw new Error(`读取失败（HTTP ${String(res.status)}）`)
  return bufferToBase64(await res.arrayBuffer())
  // #endif

  // 兜底：某些平台两者都没有
  throw new Error('当前平台无法读取本地文件')
}

function guessMediaType(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.md')) return 'text/markdown'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain'
  return 'application/octet-stream'
}

function leafName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? 'attachment'
}

/** 选图片。返回 undefined 表示用户取消。 */
export async function pickImage(): Promise<PickedFile | undefined> {
  return await new Promise<PickedFile | undefined>((resolve, reject) => {
    uni.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const paths = (res.tempFilePaths ?? []) as string[]
        const first = paths[0]
        if (first === undefined) { resolve(undefined); return }
        const files = res.tempFiles as unknown
        const meta = (Array.isArray(files) ? files[0] : files) as { path?: string; size?: number } | undefined
        const name = leafName(meta?.path ?? first)
        void readBase64(first)
          .then((data) => {
            const bytes = meta?.size ?? base64ToBytesLength(data)
            if (bytes > MAX_ATTACH_BYTES) {
              reject(new Error(`图片超过 ${String(Math.round(MAX_ATTACH_BYTES / 1024 / 1024))}MB`))
              return
            }
            resolve({ name, data, mediaType: guessMediaType(name) || 'image/jpeg', bytes })
          })
          .catch(reject)
      },
      fail: () => resolve(undefined),
    })
  })
}

/**
 * 选任意文件。
 *
 * uni.chooseFile 在 H5 与 App(3.x) 都有；有些平台没有就退回 chooseImage，
 * 至少还能发图，而不是点了没反应。
 */
export async function pickFile(): Promise<PickedFile | undefined> {
  const chooser = (uni as unknown as { chooseFile?: (o: unknown) => void }).chooseFile
  if (chooser === undefined) return await pickImage()

  return await new Promise<PickedFile | undefined>((resolve, reject) => {
    chooser.call(uni, {
      count: 1,
      success: (res: { tempFilePaths?: string[]; tempFiles?: { path?: string; name?: string; size?: number }[] }) => {
        const path = (res.tempFilePaths ?? [])[0]
        if (path === undefined) { resolve(undefined); return }
        const meta = (res.tempFiles ?? [])[0]
        const name = meta?.name ?? leafName(meta?.path ?? path)
        void readBase64(path)
          .then((data) => {
            const bytes = meta?.size ?? base64ToBytesLength(data)
            if (bytes > MAX_ATTACH_BYTES) {
              reject(new Error(`文件超过 ${String(Math.round(MAX_ATTACH_BYTES / 1024 / 1024))}MB`))
              return
            }
            resolve({ name, data, mediaType: guessMediaType(name), bytes })
          })
          .catch(reject)
      },
      fail: () => resolve(undefined),
    })
  })
}

/** 人类可读的大小。 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
