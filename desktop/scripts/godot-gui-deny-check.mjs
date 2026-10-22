#!/usr/bin/env node
// 非 headless 下的失败拦截检查（会短暂打开一个 Godot 窗口）。
//
// 覆盖三条只在 GUI 模式成立的路径：
// 1. 授权失败后弹窗出现，标题与错误码可读；
// 2. 重复触发授权失败不会重复创建弹窗（POPUP_COUNT_AFTER_RETRY 仍为 1）；
// 3. 弹窗节点异常（被销毁 / 无法显示）时，watchdog 在 5 秒宽限期后仍以 exit code 1 退出。
//
// 另有 --hold 模式：弹窗一直显示且不关闭时，进程不会在宽限期内被提前杀掉，
// 用来验证 watchdog 不会打断用户阅读错误码。
//
// 用法：GODOT_BIN=".../Godot_v4.6.3-stable_win64_console.exe" node scripts/godot-gui-deny-check.mjs [--hold]
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const godotBin = process.env.GODOT_BIN
if (!godotBin || !existsSync(godotBin)) {
  console.error('未找到 Godot 可执行文件，请设置 GODOT_BIN')
  process.exit(2)
}

const hold = process.argv.includes('--hold')
const source = join(process.cwd(), '..', 'godot')
const workDir = mkdtempSync(join(tmpdir(), 'aegis-gui-deny-'))
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
	print("POPUP_COUNT=" + str(_count()))
	for child in get_tree().root.get_children():
		if child is AcceptDialog:
			print("POPUP_TITLE=" + child.title)
			print("POPUP_TEXT=" + child.dialog_text.replace("\\n", " | "))
	var guard = get_node_or_null("/root/Aegis")
	for _i in range(5):
		guard._check()
	await get_tree().process_frame
	await get_tree().process_frame
	print("POPUP_COUNT_AFTER_RETRY=" + str(_count()))
	if ${hold ? 'true' : 'false'}:
		await get_tree().create_timer(6.0).timeout
		print("STILL_ALIVE=" + str(_count()))
		return
	for child in get_tree().root.get_children():
		if child is AcceptDialog:
			child.queue_free()
	print("POPUP_DESTROYED")


func _count() -> int:
	var total := 0
	for child in get_tree().root.get_children():
		if child is AcceptDialog:
			total += 1
	return total
`
writeFileSync(join(projectDir, 'deny_probe.gd'), probe, 'utf8')

const projectFile = join(projectDir, 'project.godot')
const projectText = readFileSync(projectFile, 'utf8').replace(
  'Aegis="*res://addons/aegis/aegis.gd"',
  'Aegis="*res://addons/aegis/aegis.gd"\nDenyProbe="*res://deny_probe.gd"'
)
writeFileSync(projectFile, projectText, 'utf8')

const timeout = hold ? 14_000 : 20_000
const started = Date.now()
const result = spawnSync(godotBin, ['--path', projectDir], { encoding: 'utf8', timeout })
const elapsedMs = Date.now() - started
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
console.log(output.trim())

const checks = {
  denied: /\[Aegis\] 授权校验失败 \(Err: 0x062\)/.test(output),
  popupFound: /POPUP_COUNT=1\b/.test(output),
  popupTitle: /POPUP_TITLE=授权校验失败/.test(output),
  popupCode: /POPUP_TEXT=.*0x062/.test(output),
  noDuplicate: /POPUP_COUNT_AFTER_RETRY=1\b/.test(output)
}

if (hold) {
  checks.stillAlive = /STILL_ALIVE=1\b/.test(output)
  checks.notKilledByWatchdog = result.status === null && elapsedMs >= 11_000
} else {
  checks.destroyed = /POPUP_DESTROYED/.test(output)
  checks.exitCode = result.status === 1
  checks.watchdogFired = elapsedMs >= 4_000 && elapsedMs <= 15_000
}

console.log('\nRESULT', JSON.stringify({ ...checks, elapsedMs, status: result.status }))
try {
  rmSync(workDir, { recursive: true, force: true })
} catch {
  // --hold 模式下进程是被外部杀掉的，临时目录可能短暂被占用，交给系统回收即可
  console.log('（临时目录暂未清理：' + workDir + '）')
}

if (Object.values(checks).some((value) => value !== true)) {
  process.exit(1)
}
