extends RefCounted
## Aegis 设备标识
##
## 设备 ID 必须满足协议 §1 的标识符规则 `[A-Za-z0-9._:-]{1,128}`，
## 并且在同一台机器上重启后保持不变。
##
## 生成策略（共同约定 v3.1 第 5 条）：
## device_id = "DEV-" + sha256(unique_id + "|" + project_id) 十六进制前 16 位。
## 1. 优先使用 OS.get_unique_id()（Windows 上来自 MachineGuid）；
## 2. 平台不提供唯一 ID 时，回退到 user://aegis_device.id 中的随机 ID（首次生成后持久化）；
## 3. 两者都不可用（例如只读目录且无唯一 ID）时返回空串，
##    由调用方拒绝授权，绝不返回一个临时随机值充当设备身份。
## project_id 加盐后，同一台机器上不同项目的设备 ID 不同，授权无法跨项目复用。
##
## 已知限制：重装系统或更换主板会改变 OS.get_unique_id()，
## 克隆机可能得到相同 ID；这属于设备身份固有限制，需由中控侧的解绑/换绑流程处理。

const PREFIX := "DEV-"
const FALLBACK_PATH := "user://aegis_device.id"
const ID_HEX_LENGTH := 16

static var _cached := ""
static var _cached_project := "" # 缓存对应的项目 ID，换项目后重新计算

static var _identifier_regex: RegEx = null


## 返回稳定设备 ID；无法确定时返回空串。project_id 为 Dock 显示的 10 位项目 ID
static func device_id(project_id: String) -> String:
	if _cached_project == project_id and not _cached.is_empty():
		return _cached
	var raw := OS.get_unique_id().strip_edges()
	if raw.is_empty():
		raw = _load_or_create_fallback()
	var result := ""
	if not raw.is_empty():
		result = PREFIX + (raw + "|" + project_id).sha256_text().substr(0, ID_HEX_LENGTH)
	_cached = result
	_cached_project = project_id
	return result


## 仅供测试与诊断：清空进程内缓存
static func reset_cache() -> void:
	_cached = ""
	_cached_project = ""


## 当前设备 ID 的来源，用于 Dock 诊断：unique_id / fallback / unavailable
static func source() -> String:
	if not OS.get_unique_id().strip_edges().is_empty():
		return "unique_id"
	if FileAccess.file_exists(FALLBACK_PATH):
		return "fallback"
	return "unavailable"


static func _load_or_create_fallback() -> String:
	if FileAccess.file_exists(FALLBACK_PATH):
		var existing := _read_fallback()
		if not existing.is_empty():
			return existing
	var generated := Crypto.new().generate_random_bytes(16).hex_encode()
	var file := FileAccess.open(FALLBACK_PATH, FileAccess.WRITE)
	if file == null:
		# 无法持久化就不能保证重启稳定，宁可失败也不返回一次性 ID
		push_error("[Aegis] 无法写入设备 ID 回退文件: %s" % FALLBACK_PATH)
		return ""
	file.store_string(generated)
	file.close()
	return generated


static func _read_fallback() -> String:
	var file := FileAccess.open(FALLBACK_PATH, FileAccess.READ)
	if file == null:
		return ""
	var text := file.get_as_text().strip_edges()
	file.close()
	if not _is_plausible(text):
		return ""
	return text


static func _is_plausible(value: String) -> bool:
	if value.length() < 16 or value.length() > 128:
		return false
	if _identifier_regex == null:
		_identifier_regex = RegEx.create_from_string("^[A-Za-z0-9._:-]+$")
	return _identifier_regex.search(value) != null
