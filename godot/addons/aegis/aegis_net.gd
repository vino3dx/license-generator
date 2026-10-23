extends Node
## Aegis 局域网授权拉取（共同约定 v3.1 第 6、7 条）
##
## 设计约束：
## - 全部等待都在 _process 里轮询完成，不阻塞主线程、不占用线程；
## - 一次拉取的总超时为 2 秒，从第一次发起连接开始计时（不是 TCP / UDP 各自 2 秒）；
## - 请求顺序：上次成功的 host:port → 127.0.0.1:47821 → UDP 47820 广播发现 → 建 TCP；
## - 失败一律静默：不改本地授权、不弹窗、不无限重试（重试节奏由 aegis.gd 的定时器决定）；
## - 网络只能延长授权：拿到的授权必须重新走 aegis_license.gd 的完整校验链，
##   且到期时间严格晚于当前本地授权，才允许原子替换 license.dat。

signal license_updated(result: Dictionary) # 新授权已落盘并通过完整校验
signal pull_finished(info: Dictionary) # 每次拉取结束（成功或失败），供日志与测试使用

const License := preload("res://addons/aegis/aegis_license.gd")
const Device := preload("res://addons/aegis/aegis_device.gd")
const StrictJson := preload("res://addons/aegis/aegis_strict_json.gd")

const UDP_PORT := 47820 # 发现端口（协议固定）
const TCP_PORT := 47821 # 拉取端口（协议固定）
const TOTAL_TIMEOUT := 2.0 # 一次拉取的总超时（秒）
const STAGE_TIMEOUT := 0.5 # 单个阶段（连接 / 发现 / 等回复）的超时（秒）
const LOOPBACK := "127.0.0.1" # 同机中控优先
const BROADCAST := "255.255.255.255"
const DISCOVER_MAX := 256 # UDP 发现包上限（协议）
const REQUEST_MAX := 4096 # TCP 请求行上限（协议）
const REPLY_MAX := 16384 # 回复上限，与授权容器上限一致
const RESPONSE_KEYS := ["v", "status", "license", "reason", "nonce"]
const STATUS_VALUES := ["issued", "unchanged", "denied"]
const IDENTIFIER_REGEX := "^[A-Za-z0-9._:-]{0,128}$"

enum State { IDLE, CONNECTING, WAITING_REPLY, DISCOVERING }

## 上次成功交换过协议的 host:port，只在进程内缓存（不落盘，避免额外状态文件）
static var _cached_host := ""
static var _cached_port := 0

var _state := State.IDLE
var _tcp: StreamPeerTCP = null
var _udp: PacketPeerUDP = null
var _deadline := 0.0 # 总超时截止（秒，单调时钟）
var _stage_deadline := 0.0 # 当前阶段截止（秒）
var _started := 0.0
var _request := PackedByteArray() # 已带结尾 \n 的请求行
var _buffer := PackedByteArray()
var _nonce := ""
var _current: Dictionary = {} # 发起时的本地授权结果（用于比较到期时间）
var _candidates: Array = [] # [{"host": String, "port": int}]
var _candidate_index := 0
var _active_host := ""
var _active_port := 0
var _from_discover := false
var _identifier_regex: RegEx = null


func _ready() -> void:
	# 不在这里关掉 _process：request_pull 可能先于 _ready 被调用，关掉会导致拉取永远不结束
	process_mode = Node.PROCESS_MODE_ALWAYS


func _exit_tree() -> void:
	_end_state()


## 仅供测试：清空 host:port 缓存
static func reset_cache() -> void:
	_cached_host = ""
	_cached_port = 0


## 发起一次拉取。current 为 License.evaluate() 的结果（可为空）。
## 上一次拉取未结束时直接丢弃本次请求，不排队、不堆积。
func request_pull(current: Dictionary = {}) -> void:
	if _state != State.IDLE:
		return
	var project := License.project_code()
	var device := Device.device_id(project)
	if device.is_empty():
		_finish(false, "", "device_unavailable")
		return
	_current = current
	_nonce = Crypto.new().generate_random_bytes(8).hex_encode()
	var request := _build_request(device, project, current).to_utf8_buffer()
	if request.size() > REQUEST_MAX:
		_finish(false, "", "request_too_large")
		return
	request.append(10) # '\n'
	_request = request
	_started = _now()
	_deadline = _started + TOTAL_TIMEOUT
	_buffer = PackedByteArray()
	_from_discover = false
	_candidates = _build_candidates()
	_candidate_index = 0
	set_process(true)
	_next_candidate()


func _process(_delta: float) -> void:
	if _state == State.IDLE:
		return
	if _now() >= _deadline:
		_abort("timeout")
		return
	match _state:
		State.CONNECTING:
			_poll_connect()
		State.WAITING_REPLY:
			_poll_reply()
		State.DISCOVERING:
			_poll_discover()


func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0


func _build_candidates() -> Array:
	var candidates := []
	if not _cached_host.is_empty() and _cached_port > 0:
		candidates.append({"host": _cached_host, "port": _cached_port})
	candidates.append({"host": LOOPBACK, "port": TCP_PORT})
	return candidates


func _next_candidate() -> void:
	while _candidate_index < _candidates.size():
		var candidate: Dictionary = _candidates[_candidate_index]
		_candidate_index += 1
		if _connect_to(String(candidate["host"]), int(candidate["port"])):
			return
	_broadcast()


func _connect_to(host: String, port: int) -> bool:
	_tcp = StreamPeerTCP.new()
	if _tcp.connect_to_host(host, port) != OK:
		_tcp = null
		return false
	_active_host = host
	_active_port = port
	_state = State.CONNECTING
	_stage_deadline = _now() + STAGE_TIMEOUT
	return true


func _poll_connect() -> void:
	# Godot 4 的 StreamPeerTCP 必须显式 poll 才会推进连接状态，否则永远停在 CONNECTING
	_tcp.poll()
	var status := _tcp.get_status()
	if status == StreamPeerTCP.STATUS_CONNECTED:
		if _tcp.put_data(_request) != OK:
			_fail_stage("send_failed")
			return
		_buffer = PackedByteArray()
		_state = State.WAITING_REPLY
		_stage_deadline = _now() + STAGE_TIMEOUT
		return
	if status == StreamPeerTCP.STATUS_ERROR or status == StreamPeerTCP.STATUS_NONE:
		_fail_stage("connect_failed")
		return
	if _now() >= _stage_deadline:
		_fail_stage("connect_timeout")


func _poll_reply() -> void:
	_tcp.poll()
	var status := _tcp.get_status()
	if status == StreamPeerTCP.STATUS_CONNECTED:
		var available := _tcp.get_available_bytes()
		if available > 0:
			# 只读到上限 + 少量余量：对端塞超大响应时不在内存里堆整段数据
			var budget := REPLY_MAX + 64 - _buffer.size()
			var chunk := _tcp.get_partial_data(mini(available, maxi(budget, 1)))
			if chunk[0] != OK:
				_abort("read_failed")
				return
			_buffer.append_array(chunk[1])
			if _buffer.size() > REPLY_MAX + 64:
				_abort("reply_too_large")
				return
	# 先看缓冲区：中控可能是「写完应答立刻关闭」，数据比 FIN 先到
	var index := _buffer.find(10)
	if index >= 0:
		_handle_reply(_buffer.slice(0, index))
		return
	# 请求已经发出去了：这里任何失败都直接终止，不再换地址重试（重试会掩盖真实错误码）
	if status != StreamPeerTCP.STATUS_CONNECTED and status != StreamPeerTCP.STATUS_CONNECTING:
		_abort("reply_closed")
		return
	if _now() >= _stage_deadline:
		_abort("reply_timeout")


func _handle_reply(line: PackedByteArray) -> void:
	if line.size() > REPLY_MAX:
		_abort("reply_too_large")
		return
	if not StrictJson.is_valid_utf8(line):
		_abort("reply_invalid_utf8")
		return
	var parsed := StrictJson.parse(line.get_string_from_utf8())
	if not parsed["ok"]:
		_abort("reply_malformed")
		return
	var value = parsed["value"]
	if typeof(value) != TYPE_DICTIONARY:
		_abort("reply_malformed")
		return
	var response: Dictionary = value
	if not _has_exact_keys(response, RESPONSE_KEYS):
		_abort("reply_keys")
		return
	var version = response["v"]
	if typeof(version) != TYPE_FLOAT and typeof(version) != TYPE_INT:
		_abort("reply_version")
		return
	if int(version) != 1:
		_abort("reply_version")
		return
	# nonce 必须原样回显，否则可能是别处 UDP 广播的串包或重放
	if typeof(response["nonce"]) != TYPE_STRING or String(response["nonce"]) != _nonce:
		_abort("reply_nonce")
		return
	if typeof(response["status"]) != TYPE_STRING:
		_abort("reply_status")
		return
	var status := String(response["status"])
	if not STATUS_VALUES.has(status):
		_abort("reply_status")
		return
	# 协议交换成功（含 unchanged / denied）：缓存地址，下次直接连
	_cache_address()
	if status != "issued":
		_end_state()
		_finish(true, status, "")
		return
	if typeof(response["license"]) != TYPE_STRING or String(response["license"]).is_empty():
		_abort("reply_license_missing")
		return
	var bytes := String(response["license"]).to_utf8_buffer()
	var result := License.evaluate_bytes(bytes, false)
	if not bool(result.get("valid", false)):
		_abort("license_invalid:" + String(result.get("code", "")))
		return
	if not _is_newer(result, _current):
		_abort("not_newer")
		return
	if not License.replace_license_bytes(bytes):
		_abort("install_failed")
		return
	# 落盘后重走一次 evaluate(true)：写时间记录并刷新剩余天数
	var final := License.evaluate(true)
	_end_state()
	emit_signal("license_updated", final)
	_finish(true, "issued", "")


## 只接受到期时间严格晚于当前本地授权的授权（防重放 / 防降级）。
## 本地没有可用到期时间时，只要求新授权校验通过。
func _is_newer(candidate: Dictionary, current: Dictionary) -> bool:
	var old_expire := String(current.get("expire", ""))
	if old_expire.is_empty():
		return true
	var old_ts := License.timestamp(old_expire)
	if old_ts < 0:
		return true
	var new_ts := License.timestamp(String(candidate.get("expire", "")))
	return new_ts > old_ts


func _poll_discover() -> void:
	while _udp != null and _udp.get_available_packet_count() > 0:
		var packet := _udp.get_packet()
		if _udp.get_packet_error() != OK:
			continue
		if packet.size() > DISCOVER_MAX or not StrictJson.is_valid_utf8(packet):
			continue
		var text := packet.get_string_from_utf8()
		if not text.begins_with("AEGIS-HERE/1 "):
			continue
		var parts := text.split(" ")
		if parts.size() != 3:
			continue
		var host := parts[1].strip_edges()
		var port := parts[2].strip_edges().to_int()
		if host.is_empty() or port <= 0 or port > 65535:
			continue
		_udp.close()
		_udp = null
		_from_discover = true
		if _connect_to(host, port):
			return
		_abort("discover_connect_failed")
		return
	if _now() >= _stage_deadline:
		_abort("discover_timeout")


func _broadcast() -> void:
	_udp = PacketPeerUDP.new()
	if _udp.bind(0) != OK:
		_abort("udp_bind_failed")
		return
	_udp.set_broadcast_enabled(true)
	if _udp.set_dest_address(BROADCAST, UDP_PORT) != OK:
		_abort("udp_dest_failed")
		return
	var project := License.project_code()
	var device := Device.device_id(project)
	var packet := ("AEGIS-DISCOVER/1 %s %s" % [device, project]).to_utf8_buffer()
	if packet.size() > DISCOVER_MAX:
		_abort("discover_too_large")
		return
	if _udp.put_packet(packet) != OK:
		_abort("udp_send_failed")
		return
	_state = State.DISCOVERING
	_stage_deadline = _now() + STAGE_TIMEOUT


func _fail_stage(code: String) -> void:
	_close_tcp()
	# 广播发现后连不上：不再重试其它地址，静默失败
	if _from_discover:
		_abort(code)
		return
	_next_candidate()


func _abort(code: String) -> void:
	_end_state()
	_finish(false, "", code)


func _end_state() -> void:
	_state = State.IDLE
	set_process(false)
	_close_tcp()
	if _udp != null:
		_udp.close()
		_udp = null
	_buffer = PackedByteArray()


## 只对仍打开的连接调用 disconnect，避免对已关闭的 socket 触发引擎报错
func _close_tcp() -> void:
	if _tcp == null:
		return
	var status := _tcp.get_status()
	if status == StreamPeerTCP.STATUS_CONNECTED or status == StreamPeerTCP.STATUS_CONNECTING:
		_tcp.disconnect_from_host()
	_tcp = null


func _finish(ok: bool, status: String, code: String) -> void:
	emit_signal(
		"pull_finished",
		{"ok": ok, "status": status, "code": code, "elapsed": _now() - _started}
	)


func _cache_address() -> void:
	if _active_port > 0 and not _active_host.is_empty():
		_cached_host = _active_host
		_cached_port = _active_port


func _build_request(device: String, project: String, current: Dictionary) -> String:
	var license_id := ""
	var last := "null"
	if not current.is_empty():
		license_id = _safe_identifier(String(current.get("license_id", "")))
		var expire := String(current.get("expire", ""))
		if not expire.is_empty():
			last = "\"%s\"" % expire
	return (
		"{\"v\":1,\"device_id\":\"%s\",\"project_id\":\"%s\",\"current_license_id\":\"%s\",\"last_expires_at\":%s,\"nonce\":\"%s\"}"
		% [device, project, license_id, last, _nonce]
	)


## 发送前兜底：只允许协议标识符字符，避免拼接出非法 JSON
func _safe_identifier(value: String) -> String:
	if _identifier_regex == null:
		_identifier_regex = RegEx.create_from_string(IDENTIFIER_REGEX)
	return value if _identifier_regex.search(value) != null else ""


func _has_exact_keys(value: Dictionary, expected: Array) -> bool:
	if value.keys().size() != expected.size():
		return false
	for key in expected:
		if not value.has(key):
			return false
	return true
