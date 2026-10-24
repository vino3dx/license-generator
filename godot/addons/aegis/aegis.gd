extends Node
## Aegis 运行时授权守卫（autoload 名: Aegis）
##
## 行为（2026-10-24 起改为「授权等待启动」）：
## - 启动时先做完整授权校验；通过才放行游戏，不显示任何等待界面。
## - 未通过（缺文件 / 过期 / 验签失败 / 设备或项目不匹配等）进入**授权等待**状态：
##   全屏纯黑 + 居中红色 MM:SS 倒计时（默认 10:00），场景树暂停，主场景不处理、不可操作。
## - 等待期间按固定间隔复用 aegis_net.gd 既有链路（UDP 47820 发现 + TCP 47821 拉取）尝试获取授权；
##   只有完整校验通过、且成功落盘的授权才会解除等待并进入游戏。
## - 倒计时归零 → get_tree().quit(1)，退出整个应用进程。
## - 运行中复查失败（到期 / 被篡改 / 设备被换等）同样进入等待状态，不再静默退出。
## - 编辑器内可用 aegis.cfg 关闭校验（Dock 可见状态）；导出后始终强制校验。
##
## 不清空 main_scene：拦截靠「暂停场景树 + 全屏不透明覆盖层 + quit」。
## autoload 的 _ready() 早于主场景实例化，覆盖层因此在第一帧就存在，游戏内容不可见；
## 但主场景 _ready() 仍会在同一帧被调用一次，受保护逻辑必须用 Aegis.is_licensed() 门控，
## 或放到 _process / _physics_process 里（等待期间这些回调不会运行）。
##
## 倒计时用 Time.get_ticks_msec()（引擎启动以来的单调毫秒）计算剩余时间，
## 不靠逐帧递减，因此不会累计误差，也不受系统时钟修改影响。
## 等待时长生产固定 600 秒；仅允许通过 `-- --aegis-wait-seconds=N` 或环境变量
## AEGIS_WAIT_SECONDS 缩短（夹在 1..600），用于自动化测试与现场排障。
## 该开关只能让拒绝状态更早结束，无法让未通过校验的授权放行。

const License := preload("res://addons/aegis/aegis_license.gd")
const Net := preload("res://addons/aegis/aegis_net.gd")
const WaitScreen := preload("res://addons/aegis/aegis_wait.gd")

const RECHECK_INTERVAL := 600.0 # 运行中复查间隔（秒）
const RENEW_POLL_INTERVAL := 21600.0 # 临期（<30 天）后台拉取间隔：6 小时
const WAIT_SECONDS := 10 # 授权等待总时长（秒），生产固定值（宽限期）
const WAIT_PULL_INTERVAL := 5.0 # 等待期间尝试获取授权的间隔（秒）
const WAIT_LAYER := 100 # 等待界面层级，高于常规游戏 UI
const WAIT_ARG_PREFIX := "--aegis-wait-seconds="
const WAIT_ENV := "AEGIS_WAIT_SECONDS"

var last_result: Dictionary = {} # 最近一次校验结果，游戏内可读取 last_result.days_left 等
var _quitting := false
var _check_timer: Timer = null
var _pull_timer: Timer = null
var _net: Node = null

var _waiting := false
var _wait_total := WAIT_SECONDS
var _wait_deadline_ms := 0
var _wait_display := -1
var _wait_layer: CanvasLayer = null
var _wait_screen: WaitScreen = null
var _wait_pull_timer: Timer = null
var _paused_before := false
var _audio_muted := false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	set_process(false)
	if not License.is_enabled():
		return
	last_result = License.evaluate()
	if bool(last_result.get("valid", false)):
		_start_recheck()
		_maybe_pull()
		return
	_enter_wait()


func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_IN and is_inside_tree() and License.is_enabled():
		_check()


func _process(_delta: float) -> void:
	if not _waiting:
		return
	# 等待期间始终保持暂停：即使游戏自己解除了暂停，也不让主场景恢复运行
	if not get_tree().paused:
		get_tree().paused = true
	var remaining_ms := _wait_deadline_ms - Time.get_ticks_msec()
	if remaining_ms <= 0:
		_update_wait_display(0)
		_quit_denied()
		return
	_update_wait_display(int(ceil(float(remaining_ms) / 1000.0)))


## 供受保护逻辑门控：授权有效且未在退出流程中。
## 编辑器内通过 aegis.cfg 显式关闭校验时返回 true（导出后 is_enabled() 恒为 true）。
func is_licensed() -> bool:
	if not License.is_enabled():
		return true
	return not _quitting and bool(last_result.get("valid", false))


## 是否处于授权等待状态（等待期间 is_licensed() 恒为 false）
func is_waiting() -> bool:
	return _waiting


## 等待界面剩余秒数（向上取整）；不在等待状态时为 0。供测试与自定义 UI 读取
func wait_remaining_seconds() -> int:
	if not _waiting:
		return 0
	var remaining_ms := _wait_deadline_ms - Time.get_ticks_msec()
	return maxi(int(ceil(float(remaining_ms) / 1000.0)), 0)


## 等待界面当前显示文本（MM:SS）；不在等待状态时为空串
func wait_display_text() -> String:
	if not _waiting:
		return ""
	return WaitScreen.format_seconds(wait_remaining_seconds())


func _check() -> void:
	if _quitting:
		return
	last_result = License.evaluate()
	if bool(last_result.get("valid", false)):
		if _waiting:
			_leave_wait()
		_maybe_pull()
		return
	if not _waiting:
		_enter_wait()


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
	# result 已在 aegis_net 内部走完「完整校验 + 原子落盘 + 重新校验」链路
	last_result = result
	if not bool(result.get("valid", false)):
		# 落盘后校验仍不通过：不放行，继续等待
		if not _waiting:
			_enter_wait()
		return
	if _waiting:
		_leave_wait()
	_start_recheck()
	if License.is_renewal_due(result):
		_maybe_pull()
	elif _pull_timer != null:
		_pull_timer.stop()


# ---------------------------------------------------------------- 授权等待状态


func _enter_wait() -> void:
	if _waiting:
		return
	_waiting = true
	_wait_total = _resolve_wait_seconds()
	_wait_deadline_ms = Time.get_ticks_msec() + _wait_total * 1000
	_wait_display = -1
	_build_wait_screen()
	_paused_before = get_tree().paused
	get_tree().paused = true
	_mute_audio()
	_update_wait_display(_wait_total)
	set_process(true)
	_start_wait_pull()


func _leave_wait() -> void:
	if not _waiting:
		return
	_waiting = false
	set_process(false)
	if _wait_pull_timer != null:
		_wait_pull_timer.stop()
		_wait_pull_timer.queue_free()
		_wait_pull_timer = null
	if _wait_layer != null:
		_wait_layer.queue_free()
		_wait_layer = null
	_wait_screen = null
	_wait_display = -1
	get_tree().paused = _paused_before
	_unmute_audio()


func _build_wait_screen() -> void:
	if _wait_layer != null:
		return
	var layer := CanvasLayer.new()
	layer.name = "AegisWaitLayer"
	layer.layer = WAIT_LAYER
	layer.process_mode = Node.PROCESS_MODE_ALWAYS
	add_child(layer)
	var screen := WaitScreen.new()
	screen.name = "AegisWaitScreen"
	screen.process_mode = Node.PROCESS_MODE_ALWAYS
	layer.add_child(screen)
	_wait_layer = layer
	_wait_screen = screen


func _update_wait_display(seconds: int) -> void:
	if seconds == _wait_display:
		return
	_wait_display = seconds
	if is_instance_valid(_wait_screen):
		_wait_screen.set_remaining(seconds)


## 等待期间按固定间隔尝试获取授权：复用 aegis_net.gd，不另建网络实现。
## 失败（无中控 / 拒绝 / 校验不通过 / 落盘失败）一律静默，倒计时继续。
func _start_wait_pull() -> void:
	_ensure_net()
	_net.request_pull({})
	if _wait_pull_timer != null:
		return
	var timer := Timer.new()
	timer.name = "AegisWaitPull"
	timer.wait_time = WAIT_PULL_INTERVAL
	timer.autostart = false
	timer.process_mode = Node.PROCESS_MODE_ALWAYS
	timer.timeout.connect(_on_wait_pull_tick)
	add_child(timer)
	_wait_pull_timer = timer
	timer.start()


func _on_wait_pull_tick() -> void:
	if _waiting and _net != null:
		_net.request_pull({})


## 等待期间静音主声道：主场景的 _ready 仍会执行一次，避免把游戏音频放出来
func _mute_audio() -> void:
	if AudioServer.get_bus_index("Master") < 0:
		return
	if AudioServer.is_bus_mute(0):
		return
	AudioServer.set_bus_mute(0, true)
	_audio_muted = true


func _unmute_audio() -> void:
	if not _audio_muted:
		return
	AudioServer.set_bus_mute(0, false)
	_audio_muted = false


## 等待时长：生产固定 600 秒，只允许被测试/排障缩短（1..600）
static func _resolve_wait_seconds() -> int:
	var raw := _wait_override_raw()
	if raw.is_empty() or not raw.is_valid_int():
		return WAIT_SECONDS
	return clampi(raw.to_int(), 1, WAIT_SECONDS)


static func _wait_override_raw() -> String:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with(WAIT_ARG_PREFIX):
			return argument.substr(WAIT_ARG_PREFIX.length()).strip_edges()
	return OS.get_environment(WAIT_ENV).strip_edges()


## 超时退出：暂停后 quit(1)，退出整个应用进程（不是切场景）。
func _quit_denied() -> void:
	if _quitting:
		return
	_quitting = true
	_waiting = false
	set_process(false)
	get_tree().paused = true
	get_tree().quit.call_deferred(1)
