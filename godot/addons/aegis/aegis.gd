extends Node
## Aegis 运行时授权守卫 (autoload 名: Aegis)
## 启动时校验一次,之后每 10 分钟及窗口重新获得焦点(如睡眠唤醒)时复查。
## 校验失败: 弹出提示框 → 退出程序 (exit code 1)。

const License := preload("res://addons/aegis/aegis_license.gd")
const RECHECK_INTERVAL := 600.0 # 运行中复查间隔(秒)

var last_result: Dictionary = {} # 最近一次校验结果,游戏内可读取 last_result.days_left 等
var _denied := false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	if not License.is_enabled():
		print("[Aegis] 授权校验已在编辑器中关闭 (aegis.cfg)。")
		return
	if not _check():
		return
	print("[Aegis] 授权有效 (到期 %s, 剩余 %d 天)。" % [last_result.expire, last_result.days_left])
	var timer := Timer.new()
	timer.wait_time = RECHECK_INTERVAL
	timer.autostart = true
	timer.timeout.connect(_check)
	add_child(timer)


func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_IN and is_inside_tree() and not _denied and License.is_enabled():
		_check()


func _check() -> bool:
	if _denied:
		return false
	last_result = License.evaluate()
	if last_result.valid:
		return true
	_deny(last_result)
	return false


func _deny(r: Dictionary) -> void:
	_denied = true
	print("[Aegis] 启动校验失败 (Err: %s)" % r.code) # 仅控制台可见,客户看不到
	get_tree().quit.call_deferred(1)
