extends RefCounted
## Aegis 授权核心（aegis-license/v1，纯静态，不依赖节点）
##
## 流程：
##   设备 ID → 内置厂商公钥验中控证书（control.cert）
##   → 证书内委托公钥验子机授权（license.dat）
##   → 项目/设备/状态/有效期绑定校验 → 防回拨 → 到期判断
##
## 安全约定：
## - 先验签、后解析业务字段；验签失败一律拒绝，不降级、不静默放行；
## - 厂商公钥是编译期常量，不来自配置或授权文件；
## - 任何一步失败都返回稳定错误码，由 aegis.gd 提示并退出。

const Secret := preload("res://addons/aegis/aegis_secret.gd")
const Verifier := preload("res://addons/aegis/aegis_rsa_verify.gd")
const Device := preload("res://addons/aegis/aegis_device.gd")
const VendorKey := preload("res://addons/aegis/aegis_vendor_key.gd")

const CONFIG_PATH := "res://addons/aegis/aegis.cfg"
const RECORD_PATH := "user://aegis_time.dat" # 上次运行时间记录（防回拨系统时钟）
const ROLLBACK_TOLERANCE := 21600 # 允许系统时钟回拨的秒数（6 小时）
const CLOCK_SKEW := 300 # 与协议一致：签发时间允许 5 分钟时钟容差

const LICENSE_FILE := "license.dat"
const CONTROL_FILE := "control.cert"

const ERR_OK := "0x000"
const ERR_LICENSE_MISSING := "0x011"
const ERR_LICENSE_EMPTY := "0x012"
const ERR_CONTROL_MISSING := "0x013"
const ERR_CONTROL_EMPTY := "0x014"
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

## 错误码对应的可诊断说明，运行期提示框与编辑器 Dock 共用
const HINTS := {
	ERR_LICENSE_MISSING: "未找到 license.dat（编辑器：工程根目录；导出后：exe 同目录）",
	ERR_LICENSE_EMPTY: "license.dat 为空",
	ERR_CONTROL_MISSING: "未找到 control.cert（中控授权证书）",
	ERR_CONTROL_EMPTY: "control.cert 为空",
	ERR_CONTROL_INVALID: "中控证书验签失败：证书被改动，或不是本厂商签发",
	ERR_LICENSE_INVALID: "子机授权验签失败：授权被改动、密钥不匹配或内容格式非法",
	ERR_CONTROL_TIME: "中控证书已过期或尚未生效",
	ERR_PROJECT_MISMATCH: "项目 ID 不在中控授权范围内，或与授权不匹配",
	ERR_CONTROL_ID_MISMATCH: "子机授权不属于当前中控证书",
	ERR_DEVICE_MISMATCH: "设备 ID 与授权不匹配：授权不是签发给这台机器",
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


static func control_path() -> String:
	return _base_dir().path_join(CONTROL_FILE)


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


## 主入口。返回 {valid, code, detail, days_left, issue, expire, project, device, license_id, control_id}
## update_record=false 时不写时间记录（编辑器 Dock 查看状态用）
static func evaluate(update_record: bool = true) -> Dictionary:
	var pc := project_code()
	var r := {
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

	# 1. 信任根必须存在，否则任何授权都无法验证
	if not VendorKey.is_configured():
		return _fail(r, ERR_VENDOR_KEY_MISSING)

	# 2. 设备身份：拿不到稳定 ID 就拒绝，不用临时值凑数
	var device := Device.device_id()
	r.device = device
	if device.is_empty():
		return _fail(r, ERR_DEVICE_UNAVAILABLE)

	var now := int(Time.get_unix_time_from_system())

	# 3. 中控证书：读字节 → 严格 UTF-8 → 结构 → 厂商公钥验签
	var control_path_value := control_path()
	var control_bytes := _read_bytes(control_path_value)
	if control_bytes.is_empty():
		if not FileAccess.file_exists(control_path_value):
			return _fail(r, ERR_CONTROL_MISSING)
		return _fail(r, ERR_CONTROL_EMPTY)
	var control := Verifier.verify_envelope_bytes(
		control_bytes, VendorKey.VENDOR_PUBLIC_KEY, "vendor-control"
	)
	if not control["ok"]:
		return _fail_detail(r, ERR_CONTROL_INVALID, String(control["detail"]))
	var control_payload: Dictionary = control["payload"]
	r.control_id = String(control_payload["license_id"])

	# 4. 中控证书时间窗口与项目范围
	var control_issued := _parse_utc(String(control_payload["issued_at"]))
	var control_expires := _parse_utc(String(control_payload["expires_at"]))
	if control_issued < 0 or control_expires < 0:
		return _fail_detail(r, ERR_CONTROL_INVALID, "timestamp_invalid")
	if control_issued > now + CLOCK_SKEW or now >= control_expires:
		return _fail(r, ERR_CONTROL_TIME)
	if not Verifier.is_project_allowed(control_payload, pc):
		return _fail(r, ERR_PROJECT_MISMATCH)

	# 5. 子机授权：用证书内的委托公钥验签
	var license_path_value := license_path()
	var license_bytes := _read_bytes(license_path_value)
	if license_bytes.is_empty():
		if not FileAccess.file_exists(license_path_value):
			return _fail(r, ERR_LICENSE_MISSING)
		return _fail(r, ERR_LICENSE_EMPTY)
	var delegated: Dictionary = control_payload["delegated_public_key"]
	var machine := Verifier.verify_envelope_bytes(license_bytes, delegated, "machine-license")
	if not machine["ok"]:
		return _fail_detail(r, ERR_LICENSE_INVALID, String(machine["detail"]))
	var machine_payload: Dictionary = machine["payload"]
	r.license_id = String(machine_payload["license_id"])
	r.issue = String(machine_payload["issued_at"])
	r.expire = String(machine_payload["expires_at"])

	# 6. 绑定关系：中控证书 ID、项目、设备、状态
	if String(machine_payload["control_license_id"]) != String(control_payload["license_id"]):
		return _fail(r, ERR_CONTROL_ID_MISMATCH)
	if String(machine_payload["project_id"]) != pc:
		return _fail(r, ERR_PROJECT_MISMATCH)
	if String(machine_payload["device_id"]) != device:
		return _fail(r, ERR_DEVICE_MISMATCH)
	if String(machine_payload["status"]) != "active":
		return _fail(r, ERR_STATUS_INACTIVE)

	# 7. 有效期：顺序、未来签发、不得超出中控证书
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

	# 8. 防回拨（保留旧版行为）与到期判断
	if not _clock_ok(update_record):
		return _fail(r, ERR_CLOCK_ROLLBACK)
	if now >= expires:
		return _fail(r, ERR_EXPIRED)

	r.days_left = int(ceil(float(expires - now) / 86400.0))
	r.valid = true
	r.code = ERR_OK
	return r
