#!/usr/bin/env node
// 非 headless 下的失败提示路径检查（会短暂打开一个 Godot 窗口）。
//
// 验证内容：
// 1. 授权失败时 AcceptDialog 被创建（标题与错误码可读）；
// 2. 触发「确定」后进程仍以 exit code 1 退出，关闭提示不能绕过校验。
//
// 用法：GODOT_BIN=".../Godot_v4.6.3-stable_win64_console.exe" node scripts/godot-gui-popup-check.mjs
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const godotBin = process.env.GODOT_BIN
if (!godotBin || !existsSync(godotBin)) {
  console.error('未找到 Godot 可执行文件，请设置 GODOT_BIN')
  process.exit(2)
}

const source = join(process.cwd(), '..', 'godot')
const workDir = mkdtempSync(join(tmpdir(), 'aegis-gui-'))
const projectDir = join(workDir, 'project')

cpSync(source, projectDir, {
  recursive: true,
  filter: (src) => {
    const base = src.split(/[\\/]/).pop() ?? ''
    return base !== '.godot' && base !== 'addons.zip' && base !== 'license.dat' && base !== 'control.cert'
  }
})

const probe = `extends Node

func _ready() -> void:
	await get_tree().create_timer(2.0).timeout
	for child in get_tree().root.get_children():
		if child is AcceptDialog:
			print("POPUP_FOUND title=" + child.title)
			child.confirmed.emit()
			print("POPUP_CONFIRMED")
			return
	print("POPUP_MISSING")
	get_tree().quit(2)
`
writeFileSync(join(projectDir, 'popup_probe.gd'), probe, 'utf8')

// 在 Aegis 之后追加探针 autoload，确保弹窗先由真实守卫创建
const projectFile = join(projectDir, 'project.godot')
const projectText = readFileSync(projectFile, 'utf8').replace(
  'Aegis="*res://addons/aegis/aegis.gd"',
  'Aegis="*res://addons/aegis/aegis.gd"\nPopupProbe="*res://popup_probe.gd"'
)
writeFileSync(projectFile, projectText, 'utf8')

const result = spawnSync(godotBin, ['--path', projectDir], {
  encoding: 'utf8',
  timeout: 30_000
})
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
console.log(output.trim())

const checks = {
  denied: /\[Aegis\] 授权校验失败 \(Err: 0x062\)/.test(output),
  popupFound: /POPUP_FOUND title=授权校验失败/.test(output),
  confirmed: /POPUP_CONFIRMED/.test(output),
  exitCode: result.status === 1
}

console.log('\nRESULT', JSON.stringify(checks))
rmSync(workDir, { recursive: true, force: true })

if (!checks.denied || !checks.popupFound || !checks.confirmed || !checks.exitCode) {
  process.exit(1)
}
