/**
 * manifest 契约回归测试。
 *
 * 为什么值得单独一个测试文件：`dsh.client` 声明了浏览器半、却没有
 * `exports["./client"]` 时，DSH 的 client-modules 会**直接抛错**
 * （`packages/client/modules/src/index.ts` 的 `clientExportOf`），
 * 而且这个错误只在真正装进 profile 时才出现——本地 `npm test` 全绿也发现不了。
 *
 * 这个测试就是把那次"装上去才炸"提前到 CI 里。
 */

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('dsh.client 声明了浏览器半时，必须导出 ./client', () => {
  const declaresClient = manifest.dsh?.client !== undefined
  if (!declaresClient) return
  assert.equal(manifest.dsh.client.platform, 'web', 'dsh.client.platform 必须是 web')
  const clientExport = manifest.exports?.['./client']
  assert.equal(
    typeof clientExport,
    'string',
    '声明了 dsh.client 却没有 exports["./client"]：DSH 会抛 ' +
      '`declares dsh.client but exports no "./client" bundle`，浏览器半永远不会加载',
  )
})

test('exports["./client"] 指向的文件真实存在', () => {
  const rel = manifest.exports?.['./client']
  if (typeof rel !== 'string') return
  assert.equal(existsSync(join(ROOT, rel)), true, `exports["./client"] 指向的 ${rel} 不存在`)
})

test('main 指向的文件存在（lib 需要先 build）', () => {
  const main = manifest.main
  assert.equal(typeof main, 'string', 'main 必须是字符串')
  assert.equal(
    existsSync(join(ROOT, main)),
    true,
    `main 指向的 ${main} 不存在——插件必须先 npm run build（测试脚本会自动 build，这条用于定位顺序错误）`,
  )
})

test('浏览器半的注册 id 与包名一致（loader 按包名去重）', () => {
  const rel = manifest.exports?.['./client']
  if (typeof rel !== 'string') return
  const source = readFileSync(join(ROOT, rel), 'utf8')
  assert.match(
    source,
    /__ModuleLoader__\.load\(\{[\s\S]*?id:\s*['"]dsh-link['"]/,
    '浏览器半必须以包名 dsh-link 注册到 __ModuleLoader__',
  )
})

test('dsh.bundle.patch 指向的文件存在且是一条 insert 条目', () => {
  const patchRel = manifest.dsh?.bundle?.patch
  assert.equal(typeof patchRel, 'string', 'dsh.bundle.patch 必须是字符串')
  const patchPath = join(ROOT, patchRel)
  assert.equal(existsSync(patchPath), true, `${patchRel} 不存在`)
  const text = readFileSync(patchPath, 'utf8')
  assert.match(text, /-\s*insert:/, 'cordis.patch.yml 必须包含 insert 条目')
  assert.match(text, /id:\s*dsh-link/, 'cordis.patch.yml 的条目 id 必须是 dsh-link')
})

test('files 字段覆盖 exports 指向的目录（打包后不能丢文件）', () => {
  const files = manifest.files ?? []
  for (const required of ['lib', 'client']) {
    assert.equal(files.includes(required), true, `files 必须包含 ${required}`)
  }
})

console.log(`\n${passed} passed`)
