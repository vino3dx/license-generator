extends Node
## Aegis 运行时授权守卫（autoload 名: Aegis）
##
## 行为（2026-10-23 用户决定，覆盖 v3.1 的「申请码界面 + 过期自动恢复」方案）：
## - 授权无效（缺失 / 过期 / 校验失败 / 设备或项目不匹配 / 旧格式等）一律**静默退出**：
##   不弹窗、不建任何界面、不打印、不写日志，退出码 1。
##   最终用户不能从本插件得到任何授权失败的原因或提示。
## - 授权有效时正常运行；临期（< 30 天）后台静默拉取续期，成功则无缝替换授权文件，不重启。
##   注意：进程一旦因授权无效退出，就没有机会再自动恢复——这是本方案的既定取舍。
## - 编辑器内可用 aegis.cfg 关闭校验（Dock 可见状态）；导出后始终强制校验。
##
## 不清空 main_scene：拦截靠「暂停场景树 + quit(1)」。autoload 的 _ready() 早于主场景
## 实例化，但主场景 _ready() 仍会在同一帧被调用一次，因此受保护逻辑必须用
## Aegis.is_licensed() 门控，或放到 _process / _physics_process 里。

const License := preload("res://addons/aegis/aegis_license.gd")
const Net := preload("res://addons/aegis/aegis_net.gd")

const RECHECK_INTERVAL := 600.0 # 运行中复查间隔（秒）
const RENEW_POLL_INTERVAL := 21600.0 # 临期（<30 天）后台拉取间隔：6 小时

var last_result: Dictionary = {} # 最近一次校验结果，游戏内可读取 last_result.days_left 等
var _quitting := false
var _check_timer: Timer = null
var _pull_timer: Timer = null
var _net: Node = null


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	if not License.is_enabled():
		return
	last_result = License.evaluate()
	if bool(last_result.get("valid", false)):
		_start_recheck()
		_maybe_pull()
		return
	_quit_denied()


func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_IN and is_inside_tree() and License.is_enabled():
		_check()


## 供受保护逻辑门控：授权有效且未在退出流程中。
## 编辑器内通过 aegis.cfg 显式关闭校验时返回 true（导出后 is_enabled() 恒为 true）。
func is_licensed() -> bool:
	if not License.is_enabled():
		return true
	return not _quitting and bool(last_result.get("valid", false))


func _check() -> void:
	if _quitting:
		return
	last_result = License.evaluate()
	if bool(last_result.get("valid", false)):
		_maybe_pull()
		return
	_quit_denied()


func _start_recheck() -> void:
	if _check_timer != null:
		return
	_check_timer = Timer.new()
	_check_timer.wait_time = RECHECK_INTERVAL
	_check_timer.autostart = true
	_check_timer.timeout.connect(_check)
	add_child(_check_timer)


## 临期窗口内才联网：有效期内完全不访问网络（网络只能延长授权，不能维持授权）
func _maybe_pull() -> void:
	if not License.is_renewal_due(last_result):
		return
	_ensure_net()
	_net.request_pull(last_result)
	_start_pull_timer(RENEW_POLL_INTERVAL)


func _ensure_net() -> void:
	if _net != null:
		return
	var net := Net.new()
	net.name = "AegisNet"
	net.license_updated.connect(_on_license_updated)
	add_child(net)
	_net = net


func _start_pull_timer(interval: float) -> void:
	if _pull_timer == null:
		_pull_timer = Timer.new()
		_pull_timer.autostart = false
		_pull_timer.timeout.connect(_on_pull_tick)
		add_child(_pull_timer)
	_pull_timer.wait_time = interval
	_pull_timer.start()


func _on_pull_tick() -> void:
	if _net != null:
		_net.request_pull(last_result)


func _on_license_updated(result: Dictionary) -> void:
	# 后台续期成功：无缝换新授权，不重启、不提示
	last_result = result
	_start_recheck()
	if License.is_renewal_due(result):
		_maybe_pull()
	elif _pull_timer != null:
		_pull_timer.stop()


## 静默失败：不打印、不弹窗、不建任何 UI。
## paused 必须在 quit 之前设置：quit 只在帧末生效，主场景 _ready 会在同帧先执行一次，
## 暂停后其 _process / _physics_process 从第一帧起就被拦住，受保护逻辑不会继续运行。
func _quit_denied() -> void:
	if _quitting:
		return
	_quitting = true
	get_tree().paused = true
	get_tree().quit.call_deferred(1)
