extends RefCounted
## Aegis 授权核心（aegis-license/v1 + 共同约定 v3.1，纯静态，不依赖节点）
##
## license.dat 是容器（严格 JSON）：{"v":1,"license":"<machine-license 信封>","control":"<vendor-control 信封>"}
## 信封与 payload 一字不改；子机不再读取单独的 control.cert 文件。
##
## 校验顺序（共同约定 v3.1 第 4 条，任一失败即拒绝）：
##   a) 容器内 control 信封：厂商公钥验签有效
##   b) 容器内 license 信封：可由 cert.delegated_public_key 验签
##   c) license.device_id == 本机设备 ID（project_id 加盐）
##   d) 本机 project_id ∈ cert.project_ids，且与 license.project_id 一致
##   e) license.expires_at <= cert.expires_at
##   f) 当前时间 < license.expires_at
## 另保留协议 §8 的 control_license_id / status 绑定校验、时间戳顺序与防回拨。
##
## 安全约定：
## - 先验签、后解析业务字段；验签失败一律拒绝，不降级、不静默放行；
## - 厂商公钥是编译期常量，不来自配置或授权文件；
## - 任何一步失败都返回稳定错误码，由 aegis.gd 提示并处理。

const Secret := preload("res://addons/aegis/aegis_secret.gd")
const Verifier := preload("res://addons/aegis/aegis_rsa_verify.gd")
const StrictJson := preload("res://addons/aegis/aegis_strict_json.gd")
const Device := preload("res://addons/aegis/aegis_device.gd")
const VendorKey := preload("res://addons/aegis/aegis_vendor_key.gd")

const CONFIG_PATH := "res://addons/aegis/aegis.cfg"
const RECORD_PATH := "user://aegis_time.dat" # 上次运行时间记录（防回拨系统时钟）
const ROLLBACK_TOLERANCE := 21600 # 允许系统时钟回拨的秒数（6 小时）
const CLOCK_SKEW := 300 # 与协议一致：签发时间允许 5 分钟时钟容差
const RENEW_WINDOW := 30 # 距到期不足该天数进入临期，开始后台拉取（天）

const LICENSE_FILE := "license.dat"
const LEGACY_CONTROL_FILE := "control.cert" # 仅用于识别旧版两文件布局，不再读取其内容
const CONTAINER_MAX := 16384 # 容器大小上限（字节）
const CONTAINER_VERSION := 1
const CONTAINER_KEYS := ["v", "license", "control"]
const TEMP_SUFFIX := ".tmp" # 原子替换授权文件时使用的临时文件后缀

const ERR_OK := "0x000"
const ERR_LICENSE_MISSING := "0x011"
const ERR_LICENSE_EMPTY := "0x012"
const ERR_CONTAINER_INVALID := "0x015"
const ERR_LEGACY_FORMAT := "0x016"
const ERR_CONTROL_INVALID := "0x021"
const ERR_LICENSE_INVALID := "0x022"
const ERR_CONTROL_TIME := "0x023"
const ERR_PROJECT_MISMATCH := "0x033"
const ERR_CONTROL_ID_MISMATCH := "0x034"
const ERR_DEVICE_MISMATCH := "0x035"
const ERR_STATUS_INACTIVE := "0x036"
const ERR_OUT_OF_CONTROL_WINDOW := "0x037"
const ERR_EXPIRY_ORDER := "0x041"
const ERR_ISSUED_IN_FUTURE := "0x051"
const ERR_CLOCK_ROLLBACK := "0x052"
const ERR_DEVICE_UNAVAILABLE := "0x061"
const ERR_VENDOR_KEY_MISSING := "0x062"
const ERR_EXPIRED := "0x099"

## 错误码对应的可诊断说明，运行期申请码界面与编辑器 Dock 共用
const HINTS := {
	ERR_LICENSE_MISSING: "未找到 license.dat（编辑器：工程根目录；导出后：exe 同目录）",
	ERR_LICENSE_EMPTY: "license.dat 为空",
	ERR_CONTAINER_INVALID: "license.dat 不是合法的授权容器（应为 {\"v\":1,\"license\",\"control\"}）",
	ERR_LEGACY_FORMAT: "旧版授权格式（裸信封或 control.cert 分离文件）：请向中控重新获取 license.dat",
	ERR_CONTROL_INVALID: "中控证书验签失败：证书被改动，或不是本厂商签发",
	ERR_LICENSE_INVALID: "子机授权验签失败：授权被改动、密钥不匹配或内容格式非法",
	ERR_CONTROL_TIME: "中控证书已过期或尚未生效",
	ERR_PROJECT_MISMATCH: "项目 ID 不在中控授权范围内，或与授权不匹配",
	ERR_CONTROL_ID_MISMATCH: "子机授权不属于当前中控证书",
	ERR_DEVICE_MISMATCH: "设备 ID 与授权不匹配：授权不是签发给这台机器（或这个项目）",
	ERR_STATUS_INACTIVE: "授权状态不是 active（可能已被吊销）",
	ERR_OUT_OF_CONTROL_WINDOW: "子机授权有效期超出中控证书有效期",
	ERR_EXPIRY_ORDER: "到期时间早于签发时间",
	ERR_ISSUED_IN_FUTURE: "系统时间早于授权签发时间",
	ERR_CLOCK_ROLLBACK: "系统时钟被回拨（可在编辑器 Dock 重置时间记录）",
	ERR_DEVICE_UNAVAILABLE: "无法确定设备 ID：系统唯一 ID 不可用且回退文件无法写入",
	ERR_VENDOR_KEY_MISSING: "未配置厂商公钥：发布前必须替换 aegis_vendor_key.gd",
	ERR_EXPIRED: "授权已到期",
}


static func hint(code: String) -> String:
	return String(HINTS.get(code, ""))


## 项目 ID = sha256(工程名 + 密钥) 前 10 位。中控签发时必须使用这个值。
static func project_code() -> String:
	var proj_name: String = ProjectSettings.get_setting("application/config/name")
	return (proj_name + Secret.SHARED_SECRET).sha256_text().substr(0, 10)


## 密钥指纹（前 8 位），用于核对工程与签发端是否使用同一份 aegis_secret.gd
static func secret_fingerprint() -> String:
	return Secret.SHARED_SECRET.sha256_text().substr(0, 8)


## 导出标记：旧流程用于让生成器从 exe 商标字段读取项目 ID，新流程仅保留作对照
static func export_tag() -> String:
	return "AG-%s-%s" % [project_code(), secret_fingerprint()]


## 编辑器里可通过 aegis.cfg 关闭校验；导出后的程序始终强制校验
static func is_enabled() -> bool:
	if not OS.has_feature("editor"):
		return true
	var cfg := ConfigFile.new()
	if cfg.load(CONFIG_PATH) != OK:
		return true
	return bool(cfg.get_value("license", "enabled", true))


static func _base_dir() -> String:
	if OS.has_feature("editor"):
		return ProjectSettings.globalize_path("res://")
	return OS.get_executable_path().get_base_dir()


static func license_path() -> String:
	return _base_dir().path_join(LICENSE_FILE)


## 旧版两文件布局中的证书路径：只用于识别旧格式，不再读取其内容
static func legacy_control_path() -> String:
	return _base_dir().path_join(LEGACY_CONTROL_FILE)


static func _read_bytes(path: String) -> PackedByteArray:
	if not FileAccess.file_exists(path):
		return PackedByteArray()
	return FileAccess.get_file_as_bytes(path)


## 协议时间为 UTC `YYYY-MM-DDTHH:MM:SSZ`；Godot 该 API 按 UTC 解释。
## 解析失败返回 -1。反向格式化必须与原文一致：`2026-13-45T99:99:99Z` 这类值能通过
## 格式正则但不是合法日历时间，必须拒绝（Node 端 isTimestamp 用 Date.parse 同样拒绝）。
static func _parse_utc(value: String) -> int:
	if not value.ends_with("Z"):
		return -1
	var text := value.substr(0, value.length() - 1)
	var stamp := int(Time.get_unix_time_from_datetime_string(text))
	if stamp <= 0:
		return -1
	if Time.get_datetime_string_from_unix_time(stamp, false) != text:
		return -1
	return stamp


static func _record_checksum(stamp: int) -> String:
	return ("%d|%s|%s" % [stamp, Secret.SHARED_SECRET, project_code()]).sha256_text().substr(0, 16)


## 读取上次运行时间戳；文件不存在 / 损坏 / 被改动 → 返回 0（视为无记录，不误伤客户）
static func _load_record() -> int:
	if not FileAccess.file_exists(RECORD_PATH):
		return 0
	var f := FileAccess.open(RECORD_PATH, FileAccess.READ)
	if f == null:
		return 0
	var parts := f.get_as_text().strip_edges().split(":")
	f.close()
	if parts.size() != 2 or not parts[0].is_valid_int():
		return 0
	var stamp := parts[0].to_int()
	if parts[1] != _record_checksum(stamp):
		return 0
	return stamp


## 时钟检查：当前时间明显早于上次记录 → 判定为回拨。只前进不后退地更新记录。
## 写记录失败（只读目录等）不影响授权结果。
static func _clock_ok(update_record: bool) -> bool:
	var now := int(Time.get_unix_time_from_system())
	var last := _load_record()
	if last > 0 and now + ROLLBACK_TOLERANCE < last:
		return false
	if update_record and now > last:
		var f := FileAccess.open(RECORD_PATH, FileAccess.WRITE)
		if f != null:
			f.store_string("%d:%s" % [now, _record_checksum(now)])
			f.close()
	return true


static func reset_time_record() -> void:
	if FileAccess.file_exists(RECORD_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(RECORD_PATH))


static func _empty_result() -> Dictionary:
	var pc := project_code()
	return {
		"valid": false,
		"code": "",
		"detail": "",
		"days_left": -1,
		"issue": "",
		"expire": "",
		"project": pc,
		"device": "",
		"license_id": "",
		"control_id": ""
	}


## 协议时间戳的公开解析入口（-1 表示非法）；网络层比较到期时间时复用同一个解析器
static func timestamp(value: String) -> int:
	return _parse_utc(value)


static func _has_exact_keys(value: Dictionary, expected: Array) -> bool:
	if value.keys().size() != expected.size():
		return false
	for key in expected:
		if not value.has(key):
			return false
	return true


static func _container_fail(code: String, detail: String) -> Dictionary:
	return {"ok": false, "code": code, "detail": detail, "license": "", "control": ""}


## 严格解析 license.dat 容器（共同约定 v3.1 第 3 条）。
## 返回 {ok, code, detail, license, control}：
## - 旧版裸信封或旧两文件布局 → 0x016；其余结构问题 → 0x015（都给明确错误码，不崩溃）。
## - 键集合严格、版本必须为 1、两个字段必须是非空字符串、整体不超过 16384 字节。
static func parse_container(bytes: PackedByteArray) -> Dictionary:
	if bytes.is_empty():
		return _container_fail(ERR_LICENSE_EMPTY, "")
	if bytes.size() > CONTAINER_MAX:
		return _container_fail(ERR_CONTAINER_INVALID, "container_too_large")
	if not StrictJson.is_valid_utf8(bytes):
		return _container_fail(ERR_CONTAINER_INVALID, "json_invalid_utf8")
	var text := bytes.get_string_from_utf8()
	var parsed := StrictJson.parse(text)
	if not parsed["ok"]:
		# 旧版把裸信封直接写进 license.dat：能确认为信封时给旧格式错误码
		if text.contains("license-envelope"):
			return _container_fail(ERR_LEGACY_FORMAT, "")
		return _container_fail(ERR_CONTAINER_INVALID, String(parsed["error"]))
	var value = parsed["value"]
	if typeof(value) != TYPE_DICTIONARY:
		return _container_fail(ERR_CONTAINER_INVALID, "container_not_object")
	var container: Dictionary = value
	if container.has("aegis"):
		return _container_fail(ERR_LEGACY_FORMAT, "")
	if not _has_exact_keys(container, CONTAINER_KEYS):
		return _container_fail(ERR_CONTAINER_INVALID, "container_keys")
	var version = container["v"]
	if typeof(version) != TYPE_FLOAT and typeof(version) != TYPE_INT:
		return _container_fail(ERR_CONTAINER_INVALID, "container_version")
	if int(version) != CONTAINER_VERSION:
		return _container_fail(ERR_CONTAINER_INVALID, "container_version")
	var license_text = container["license"]
	var control_text = container["control"]
	if typeof(license_text) != TYPE_STRING or typeof(control_text) != TYPE_STRING:
		return _container_fail(ERR_CONTAINER_INVALID, "container_fields")
	if String(license_text).is_empty() or String(control_text).is_empty():
		return _container_fail(ERR_CONTAINER_INVALID, "container_fields")
	return {
		"ok": true,
		"code": ERR_OK,
		"detail": "",
		"license": String(license_text),
		"control": String(control_text)
	}


## 是否需要进入临期拉取窗口：剩余天数 < RENEW_WINDOW。
## 传入 evaluate() 的结果可避免重复验签；不传则内部重新校验（不写时间记录）。
static func is_renewal_due(result: Dictionary = {}) -> bool:
	var r := result
	if r.is_empty():
		r = evaluate(false)
	if not bool(r.get("valid", false)):
		return false
	var days := int(r.get("days_left", -1))
	return days >= 0 and days < RENEW_WINDOW


## 原子替换 license.dat（临时文件 + rename），「导入授权文件」与「局域网拉取」共用。
## 失败时保持原文件不变并清理临时文件。
static func replace_license_bytes(bytes: PackedByteArray) -> bool:
	if bytes.is_empty() or bytes.size() > CONTAINER_MAX:
		return false
	var target := license_path()
	var temp := target + TEMP_SUFFIX
	var file := FileAccess.open(temp, FileAccess.WRITE)
	if file == null:
		return false
	file.store_buffer(bytes)
	file.close()
	var dir := DirAccess.open(_base_dir())
	if dir == null:
		DirAccess.remove_absolute(temp)
		return false
	# 部分文件系统不允许 rename 覆盖已存在文件，失败时退化为「先删后改名」（窗口极短）
	if dir.rename(temp.get_file(), LICENSE_FILE) != OK:
		DirAccess.remove_absolute(target)
		if dir.rename(temp.get_file(), LICENSE_FILE) != OK:
			DirAccess.remove_absolute(temp)
			return false
	return true


## 导入外部授权文件：先完整校验，通过后才原子替换；返回最终 evaluate() 结果
static func install_from_path(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		var missing := _empty_result()
		missing.device = Device.device_id(String(missing["project"]))
		return _fail(missing, ERR_LICENSE_MISSING)
	var bytes := _read_bytes(path)
	if bytes.is_empty():
		var empty := _empty_result()
		empty.device = Device.device_id(String(empty["project"]))
		return _fail(empty, ERR_LICENSE_EMPTY)
	var result := evaluate_bytes(bytes, false)
	if not bool(result["valid"]):
		return result
	if not replace_license_bytes(bytes):
		return _fail_detail(result, ERR_CONTAINER_INVALID, "install_failed")
	# 落盘成功后再写一次时间记录并重算剩余天数，保证与后续 evaluate() 完全一致
	return evaluate(true)


static func _fail(r: Dictionary, code: String) -> Dictionary:
	r.valid = false
	r.code = code
	r.detail = ""
	return r


static func _fail_detail(r: Dictionary, code: String, detail: String) -> Dictionary:
	r.valid = false
	r.code = code
	r.detail = detail
	return r


## 主入口：读取固定位置的 license.dat 并校验。
## 返回 {valid, code, detail, days_left, issue, expire, project, device, license_id, control_id}
## update_record=false 时不写时间记录（编辑器 Dock 查看状态用）
static func evaluate(update_record: bool = true) -> Dictionary:
	# 信任根优先：未配置厂商公钥时任何授权都不可能是有效的，先报 0x062，
	# 否则发布前检查会看到「未找到 license.dat」而误以为只是漏拷文件。
	if not VendorKey.is_configured():
		var unconfigured := _empty_result()
		unconfigured.device = Device.device_id(String(unconfigured["project"]))
		return _fail(unconfigured, ERR_VENDOR_KEY_MISSING)
	var path := license_path()
	if not FileAccess.file_exists(path):
		var missing := _empty_result()
		missing.device = Device.device_id(String(missing["project"]))
		# 旧版两文件布局（有 control.cert 没有容器）给明确的旧格式错误码，不误报为「缺失」
		if FileAccess.file_exists(legacy_control_path()):
			return _fail(missing, ERR_LEGACY_FORMAT)
		return _fail(missing, ERR_LICENSE_MISSING)
	return evaluate_bytes(_read_bytes(path), update_record)


## 校验任意容器字节：导入授权文件与局域网拉取共用同一套链路，不重复实现校验。
## 默认不写防回拨时间记录，只有真正生效的本地授权才更新时间基线。
static func evaluate_bytes(container_bytes: PackedByteArray, update_record: bool = false) -> Dictionary:
	var r := _empty_result()
	var pc := String(r["project"])

	# 1. 信任根必须存在，否则任何授权都无法验证
	if not VendorKey.is_configured():
		return _fail(r, ERR_VENDOR_KEY_MISSING)

	# 2. 设备身份：拿不到稳定 ID 就拒绝，不用临时值凑数
	var device := Device.device_id(pc)
	r.device = device
	if device.is_empty():
		return _fail(r, ERR_DEVICE_UNAVAILABLE)

	var now := int(Time.get_unix_time_from_system())

	# 3. 容器：严格 JSON、键集合固定、16384 字节上限；旧格式给明确错误码
	var container := parse_container(container_bytes)
	if not container["ok"]:
		return _fail_detail(r, String(container["code"]), String(container["detail"]))

	# 4. (a) 中控证书：内置厂商公钥验签
	var control := Verifier.verify_envelope_text(
		String(container["control"]), VendorKey.VENDOR_PUBLIC_KEY, "vendor-control"
	)
	if not control["ok"]:
		return _fail_detail(r, ERR_CONTROL_INVALID, String(control["detail"]))
	var control_payload: Dictionary = control["payload"]
	r.control_id = String(control_payload["license_id"])

	# 5. 证书时间窗口（协议 §4：issued_at / expires_at 必须合法）
	var control_issued := _parse_utc(String(control_payload["issued_at"]))
	var control_expires := _parse_utc(String(control_payload["expires_at"]))
	if control_issued < 0 or control_expires < 0:
		return _fail_detail(r, ERR_CONTROL_INVALID, "timestamp_invalid")
	if control_issued > now + CLOCK_SKEW or now >= control_expires:
		return _fail(r, ERR_CONTROL_TIME)

	# 6. (b) 子机授权：用证书内的委托公钥验签
	var delegated: Dictionary = control_payload["delegated_public_key"]
	var machine := Verifier.verify_envelope_text(String(container["license"]), delegated, "machine-license")
	if not machine["ok"]:
		return _fail_detail(r, ERR_LICENSE_INVALID, String(machine["detail"]))
	var machine_payload: Dictionary = machine["payload"]
	r.license_id = String(machine_payload["license_id"])
	r.issue = String(machine_payload["issued_at"])
	r.expire = String(machine_payload["expires_at"])

	# 7. (c) 设备绑定
	if String(machine_payload["device_id"]) != device:
		return _fail(r, ERR_DEVICE_MISMATCH)

	# 8. (d) 项目绑定：授权项目必须等于本机，且本机在证书范围内
	if String(machine_payload["project_id"]) != pc:
		return _fail(r, ERR_PROJECT_MISMATCH)
	if not Verifier.is_project_allowed(control_payload, pc):
		return _fail(r, ERR_PROJECT_MISMATCH)

	# 9. 证书归属与状态（协议 §8 第 5 步）
	if String(machine_payload["control_license_id"]) != String(control_payload["license_id"]):
		return _fail(r, ERR_CONTROL_ID_MISMATCH)
	if String(machine_payload["status"]) != "active":
		return _fail(r, ERR_STATUS_INACTIVE)

	# 10. (e) 子机授权有效期不得超过中控证书；时间戳顺序与未来签发一并检查
	var issued := _parse_utc(r.issue)
	var expires := _parse_utc(r.expire)
	if issued < 0 or expires < 0:
		return _fail_detail(r, ERR_LICENSE_INVALID, "timestamp_invalid")
	if expires <= issued:
		return _fail(r, ERR_EXPIRY_ORDER)
	if issued > now + CLOCK_SKEW:
		return _fail(r, ERR_ISSUED_IN_FUTURE)
	if expires > control_expires:
		return _fail(r, ERR_OUT_OF_CONTROL_WINDOW)

	# 11. 防回拨（保留旧版行为）与 (f) 当前时间必须早于到期时间
	if not _clock_ok(update_record):
		return _fail(r, ERR_CLOCK_ROLLBACK)
	if now >= expires:
		return _fail(r, ERR_EXPIRED)

	r.days_left = int(ceil(float(expires - now) / 86400.0))
	r.valid = true
	r.code = ERR_OK
	return r
