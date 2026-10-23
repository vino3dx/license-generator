#!/usr/bin/env node
// 在 Godot 环境下运行 GDScript 验签交叉验证。
//
// 目录约定（仓库级）：
//   tests/integration/verifier-godot/  独立 headless 验证工程（RSA/严格 JSON 的唯一可维护源）
//   tests/vectors/vectors.json         跨语言协议测试向量
//
// 用法（在 desktop/ 下执行）：
//   GODOT_BIN="E:/Program Files/Godot Engine/Godot_v4.6.3-stable_win64_console.exe" npm run godot:vectors
//   GODOT_BIN=... npm run godot:release   （导出 Release 模板后再测一次耗时）
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '..')
const godotBin = process.env.GODOT_BIN
if (!godotBin || !existsSync(godotBin)) {
  console.error('未找到 Godot 可执行文件，请设置 GODOT_BIN 指向 Godot 4.6.3 的 console 版本')
  process.exit(1)
}

const projectDir = join(repoRoot, 'tests', 'integration', 'verifier-godot')
const vectorsSource = join(repoRoot, 'tests', 'vectors', 'vectors.json')
if (!existsSync(vectorsSource)) {
  console.error('缺少 tests/vectors/vectors.json，请先执行 AEGIS_WRITE_VECTORS=1 npm test')
  process.exit(1)
}

function run(args, label) {
  console.log(`\n[${label}] ${godotBin} ${args.join(' ')}`)
  const result = spawnSync(godotBin, args, { cwd: repoRoot, stdio: 'inherit' })
  return result.status ?? 1
}

copyFileSync(vectorsSource, join(projectDir, 'vectors.json'))

if (process.argv.includes('--release')) {
  mkdirSync(join(projectDir, 'build'), { recursive: true })
  const exportStatus = run(
    ['--headless', '--path', projectDir, '--export-release', 'Windows Release', 'build/AegisVerifier.exe'],
    'export'
  )
  if (exportStatus !== 0) {
    process.exit(exportStatus)
  }
  process.exit(run([join(projectDir, 'build', 'AegisVerifier.exe'), '--headless'], 'release-run'))
}

process.exit(run(['--headless', '--path', projectDir, '-s', 'run_vectors.gd'], 'headless'))
