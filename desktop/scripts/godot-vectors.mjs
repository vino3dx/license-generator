#!/usr/bin/env node
// 在 Godot 环境下运行 GDScript 验签交叉验证。
// 用法：
//   GODOT_BIN="E:/Program Files/Godot Engine/Godot_v4.6.3-stable_win64_console.exe" npm run godot:vectors
//   GODOT_BIN=... npm run godot:release   （导出 Release 模板后再测一次耗时）
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const projectRoot = process.cwd()
const godotBin = process.env.GODOT_BIN
if (!godotBin || !existsSync(godotBin)) {
  console.error('未找到 Godot 可执行文件，请设置 GODOT_BIN 指向 Godot 4.6.3 的 console 版本')
  process.exit(1)
}

const projectDir = join(projectRoot, 'verifier-godot')
const vectorsSource = join(projectRoot, 'tests', 'fixtures', 'vectors.json')
if (!existsSync(vectorsSource)) {
  console.error('缺少 tests/fixtures/vectors.json，请先执行 AEGIS_WRITE_VECTORS=1 npm test')
  process.exit(1)
}

function run(args, label) {
  console.log(`\n[${label}] ${godotBin} ${args.join(' ')}`)
  const result = spawnSync(godotBin, args, { cwd: projectRoot, stdio: 'inherit' })
  return result.status ?? 1
}

if (process.argv.includes('--release')) {
  copyFileSync(vectorsSource, join(projectDir, 'vectors.json'))
  const buildDir = join(projectDir, 'build')
  mkdirSync(buildDir, { recursive: true })
  // 导出路径相对于项目目录（verifier-godot/build/），不是仓库根目录
  const exportStatus = run(
    ['--headless', '--path', 'verifier-godot', '--export-release', 'Windows Release', 'build/AegisVerifier.exe'],
    'export'
  )
  if (exportStatus !== 0) {
    process.exit(exportStatus)
  }
  process.exit(run([join(projectDir, 'build', 'AegisVerifier.exe'), '--headless'], 'release-run'))
}

copyFileSync(vectorsSource, join(projectDir, 'vectors.json'))
process.exit(run(['--headless', '--path', 'verifier-godot', '-s', 'run_vectors.gd'], 'headless'))
