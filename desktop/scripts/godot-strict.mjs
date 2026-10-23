#!/usr/bin/env node
// 在 Godot 4.6.3 headless 下运行严格 JSON 共享向量。
// 用法（在 desktop/ 下执行）：
//   GODOT_BIN=".../Godot_v4.6.3-stable_win64_console.exe" npm run godot:strict
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const godotBin = process.env.GODOT_BIN
if (!godotBin || !existsSync(godotBin)) {
  console.error('未找到 Godot 可执行文件，请设置 GODOT_BIN 指向 Godot 4.6.3 的 console 版本')
  process.exit(1)
}

const projectDir = join(resolve(process.cwd(), '..'), 'tests', 'integration', 'verifier-godot')
const result = spawnSync(godotBin, ['--headless', '--path', projectDir, '-s', 'strict_json_runner.gd'], {
  stdio: 'inherit'
})
process.exit(result.status ?? 1)
