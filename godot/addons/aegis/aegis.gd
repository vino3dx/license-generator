extends Node
## Aegis 运行时授权守卫（autoload 名: Aegis）
## 启动时校验一次，之后每 10 分钟及窗口重新获得焦点（如睡眠唤醒）时复查。
##
## 校验失败：暂停场景树 → 记录日志 → 显示可关闭的错误提示 → 退出程序（exit code 1）。
## 提示框只有「确定」，关闭它等同于确认失败，不会继续运行；headless 环境直接退出。
##
## 启动时机说明（Godot 固定顺序）：
##   autoload._ready() 先于主场景实例化执行，因此校验发生在任何游戏逻辑之前；
##   但 quit() 只在当前帧末生效，主场景的 _ready() 仍会在同一帧内被调用一次。
##   受保护逻辑必须放在 _process/_physics_process，或用 Aegis.is_licensed() 门控后再启动。

const License := preload("res://addons/aegis/aegis_license.gd")
const RECHECK_INTERVAL := 600.0 # 运行中复查间隔（秒）
const DIALOG_GRACE := 5.0 # 弹窗未显示时的兜底等待（秒）
const DIALOG_HARD_TIMEOUT := 30.0 # 弹窗已显示但始终未关闭时的强制退出等待（秒）

var last_result: Dictionary = {} # 最近一次校验结果，游戏内可读取 last_result.days_left 等
var _denied := false
var _quitting := false
var _dialog: AcceptDialog = null


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	if not License.is_enabled():
		print("[Aegis] 授权校验已在编辑器中关闭 (aegis.cfg)。")
		return
	if not _check():
		return
	print("[Aegis] 授权有效（到期 %s，剩余 %d 天）。" % [last_result.expire, last_result.days_left])
	var timer := Timer.new()
	timer.wait_time = RECHECK_INTERVAL
	timer.autostart = true
	timer.timeout.connect(_check)
	add_child(timer)


func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_IN and is_inside_tree() and not _denied and License.is_enabled():
		_check()


## 供受保护逻辑门控：授权有效且未被拒绝。
## 主场景 _ready() 一定晚于本 autoload，但同一帧内仍会被调用，业务入口应以此为准。
## 编辑器内通过 aegis.cfg 显式关闭校验时返回 true（导出后 is_enabled() 恒为 true）。
func is_licensed() -> bool:
	if not License.is_enabled():
		return true
	return not _denied and bool(last_result.get("valid", false))


func _check() -> bool:
	if _denied:
		return false
	last_result = License.evaluate()
	if last_result.valid:
		return true
	_deny(last_result)
	return false


func _deny(r: Dictionary) -> void:
	if _denied:
		return
	_denied = true
	var detail := String(r.get("detail", ""))
	var suffix := (" detail=%s" % detail) if not detail.is_empty() else ""
	print("[Aegis] 授权校验失败 (Err: %s%s)" % [r.code, suffix])

	# 先暂停场景树：默认 PROCESS_MODE_INHERIT 的节点（含随后实例化的主场景）
	# 不会再执行 _process / _physics_process，失败后受保护逻辑不会继续运行。
	get_tree().paused = true

	# headless / 无显示环境下弹窗没有意义，直接以失败退出
	if DisplayServer.get_name() == "headless":
		_quit(1)
		return

	var dialog := AcceptDialog.new()
	dialog.title = "授权校验失败"
	dialog.dialog_text = "错误码：%s\n%s\n\n程序将退出。" % [r.code, License.hint(r.code)]
	dialog.exclusive = true
	dialog.unresizable = true
	dialog.process_mode = Node.PROCESS_MODE_ALWAYS
	dialog.confirmed.connect(_quit_after_denial)
	dialog.canceled.connect(_quit_after_denial)
	_dialog = dialog

	# autoload 的 _ready 阶段根节点正在装配子节点，直接 add_child 会失败，
	# 必须延迟挂载，否则弹窗不会出现、进程也不会退出。
	get_tree().root.add_child.call_deferred(dialog)
	dialog.popup_centered.call_deferred()
	_watchdog()


## 兜底：弹窗若因环境异常未能显示，5 秒后仍按失败退出；
## 弹窗显示了但用户始终不关闭时，30 秒后同样强制退出，
## 避免「失败后进程无限挂起」（PROCESS_MODE_ALWAYS 的节点不会被 paused 拦住）。
func _watchdog() -> void:
	await get_tree().create_timer(DIALOG_GRACE, true).timeout
	if is_instance_valid(_dialog) and _dialog.visible:
		await get_tree().create_timer(DIALOG_HARD_TIMEOUT, true).timeout
		_quit(1)
		return
	_quit(1)


## 无论用户点确定还是按 ESC 关闭，都按失败退出：关闭提示不能绕过授权校验
func _quit_after_denial() -> void:
	_quit(1)


## 退出只执行一次，避免弹窗回调与 watchdog 重复触发退出流程
func _quit(code: int) -> void:
	if _quitting:
		return
	_quitting = true
	get_tree().quit.call_deferred(code)
