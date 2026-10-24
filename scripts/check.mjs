#!/usr/bin/env node
/**
 * 工程根的检查入口：按依赖顺序跑子工程的构建与测试。
 *
 * 顺序不是随便排的：
 *   1. 协议先 build —— 插件的类型与运行时都读它的 dist/，不先编插件必红
 *   2. 插件再 build + test —— test 脚本自己会 build，但显式分开能让失败定位更快
 *   3. App 最后 —— 2026-10-24 起 App 已迁出为独立工程 ../moss-ai-app（见 docs/14），
 *      只在该目录存在时顺带跑它；它依赖自己的 protocol/ 快照，不与插件耦合
 *
 * 用法：
 *   node scripts/check.mjs                 全量（含 H5 构建）
 *   node scripts/check.mjs --skip-app-build 跳过 H5 构建（本地快速回路）
 *   node scripts/check.mjs --only=protocol,plugin
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_ROOT = resolve(ROOT, '../moss-ai-app') // 独立后的移动端工程
const argv = process.argv.slice(2)
const skipAppBuild = argv.includes('--skip-app-build')
const onlyArg = argv.find((a) => a.startsWith('--only='))
const only = onlyArg === undefined ? undefined : new Set(onlyArg.slice('--only='.length).split(','))

/** 一步检查。cwd 相对工程根（可越出到 ../moss-ai-app），args 里不要带 shell 元字符（不经过 shell）。 */
const steps = [
  {
    id: 'protocol',
    label: '协议：构建 + 24 项自测（产出 dist/，插件依赖它）',
    cwd: 'shared/protocol',
    bin: 'npm',
    args: ['test'],
    requires: ['shared/protocol/node_modules'],
  },
  {
    id: 'plugin',
    label: '插件：编译 + 16 项自测',
    cwd: 'plugin',
    bin: 'npm',
    args: ['test'],
    requires: ['plugin/node_modules'],
  },
  {
    id: 'app-typecheck',
    label: 'App（../moss-ai-app）：vue-tsc 类型检查',
    cwd: '../moss-ai-app',
    bin: 'npm',
    args: ['run', 'typecheck'],
    requires: ['../moss-ai-app/node_modules'],
    external: true,
  },
  ...(skipAppBuild
    ? []
    : [
        {
          id: 'app-build',
          label: 'App（../moss-ai-app）：H5 构建（体积预算 400KB）',
          cwd: '../moss-ai-app',
          bin: 'npm',
          args: ['run', 'build:h5'],
          requires: ['../moss-ai-app/node_modules'],
          external: true,
        },
      ]),
].filter((step) => !step.external || existsSync(APP_ROOT))

/** 依赖缺失时给出可执行的修复命令，而不是一句 ENOENT。
 *
 * 注意 `requires` 只放"装完依赖就该存在"的东西（node_modules）。
 * 构建产物（如 shared/protocol/dist）不能放进来：它们在 CI 里 checkout 后
 * 本来就不存在，要由前面的步骤生产出来。把产物写成前置依赖会得到一个
 * 永远无法通过的检查——这正是 CI 第一版踩到的坑。 */
function missingDependency(step) {
  for (const rel of step.requires) {
    if (!existsSync(join(ROOT, rel))) return rel
  }
  return undefined
}

function run(step) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const child = spawn(step.bin, step.args, {
      cwd: join(ROOT, step.cwd),
      stdio: 'inherit',
      env: { ...process.env, CI: '1', NO_COLOR: '0' },
    })
    child.on('error', (err) => {
      resolvePromise({ step, ok: false, ms: Date.now() - started, error: err.message })
    })
    child.on('close', (code) => {
      resolvePromise({ step, ok: code === 0, ms: Date.now() - started, code })
    })
  })
}

const selected = steps.filter((s) => only === undefined || only.has(s.id))

const missing = selected
  .map((step) => ({ step, dep: missingDependency(step) }))
  .filter((entry) => entry.dep !== undefined)

if (missing.length > 0) {
  console.error('\n✗ 依赖未安装或协议未构建：\n')
  for (const { step, dep } of missing) console.error(`  · ${step.label} 缺少 ${dep}`)
  console.error('\n修复：npm run install:all && npm run build:protocol\n')
  process.exit(1)
}

console.log(`\nDSH Link 检查 · ${String(selected.length)} 步 · Node ${process.version}\n`)

const results = []
for (const step of selected) {
  console.log(`\n▶ ${step.label}`)
  const result = await run(step)
  results.push(result)
  console.log(result.ok ? `✓ ${step.label}（${String(result.ms)}ms）` : `✗ ${step.label}（退出码 ${String(result.code ?? result.error)}）`)
  // 任何一步失败立即停：后面的步骤依赖前面的产物，继续跑只会产生噪声错误。
  if (!result.ok) break
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + '─'.repeat(60))
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.step.id.padEnd(16)} ${String(r.ms).padStart(6)}ms`)
}
const skipped = selected.slice(results.length)
if (skipped.length > 0) {
  console.log(`\n因上游失败跳过：${skipped.map((s) => s.id).join(', ')}`)
}
console.log('─'.repeat(60))

if (failed.length > 0) {
  console.error(`\n✗ 检查失败：${failed.map((f) => f.step.id).join(', ')}\n`)
  process.exit(1)
}
console.log('\n✓ 全部通过\n')
