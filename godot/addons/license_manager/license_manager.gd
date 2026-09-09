extends Node
## === 离线授权许可管理 v2 ===
## 变更要点（相对旧版）：
##  - 不再使用全项目通用的写死 KEY，改为每个项目独立的派生密钥 (见 license_key.gd)
##  - IV 不再固定，随机生成并附带在授权文件前 16 字节
##  - 增加 project 字段校验，防止 license.dat 被跨项目复用
##  - 保留原有的到期校验、时钟回拨检测
## 授权 JSON 示例：
## { "issue":"2026-07-24", "expire":"2027-12-30", "project":"GAME_A", "license_id":"..." }
## ====================================

const LICENSE_CONFIG_PATH := "res://addons/license_manager/license_config.cfg"
const TIME_RECORD_PATH := "user://sys_time.dat"
const LicenseKeyScript := preload("res://addons/license_manager/license_key.gd")


func _ready():
	if not _is_module_enabled():
		print("【LSM】模块已禁用（license_config.cfg），跳过。")
		return

	var result := evaluate_license()
	if not result.valid:
		await get_tree().process_frame
		get_tree().quit()


# =========================
# 获取 license 路径
# =========================
func get_license_path() -> String:
	if OS.has_feature("editor"):
		return ProjectSettings.globalize_path("res://") + "license.dat"
	return OS.get_executable_path().get_base_dir() + "/license.dat"


# =========================
# 读取模块自身开关
# =========================
func _is_module_enabled() -> bool:
	var config := ConfigFile.new()
	var err := config.load(LICENSE_CONFIG_PATH)
	if err == OK:
		return config.get_value("license", "enabled", true)
	return true


# =========================
# 读取文件
# =========================
func read_file(path: String) -> String:
	if not FileAccess.file_exists(path):
		return ""
	var f = FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var txt = f.get_as_text()
	f.close()
	return txt.strip_edges().replace("\n", "").replace("\r", "").replace(" ", "")


# =========================
# AES-256-CBC 解密
# IV 内嵌在授权文件解码后的前 16 字节，其余为密文
# =========================
func decrypt(base64_text: String, key: PackedByteArray) -> String:
	if key.size() != 32:
		return ""

	var raw: PackedByteArray = Marshalls.base64_to_raw(base64_text)
	if raw.size() <= 16:
		return ""

	var iv: PackedByteArray = raw.slice(0, 16)
	var encrypted: PackedByteArray = raw.slice(16)
	if encrypted.size() == 0 or encrypted.size() % 16 != 0:
		return ""

	var aes := AESContext.new()
	aes.start(AESContext.MODE_CBC_DECRYPT, key, iv)
	var decrypted: PackedByteArray = aes.update(encrypted)
	aes.finish()

	if decrypted.size() == 0:
		return ""

	var pad_len = decrypted[decrypted.size() - 1]
	if pad_len < 1 or pad_len > 16 or pad_len > decrypted.size():
		return ""
	for i in range(pad_len):
		if decrypted[decrypted.size() - 1 - i] != pad_len:
			return ""
	decrypted = decrypted.slice(0, decrypted.size() - pad_len)

	return decrypted.get_string_from_utf8()


# =========================
# JSON 解析
# =========================
func parse_json(text: String) -> Dictionary:
	var result = JSON.parse_string(text)
	if result == null or not result is Dictionary:
		return {}
	return result


func is_leap_year(year: int) -> bool:
	return (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)


func is_valid_date(date_str: String) -> bool:
	if date_str.length() != 10:
		return false
	var parts = date_str.split("-")
	if parts.size() != 3:
		return false
	var year = parts[0].to_int()
	var month = parts[1].to_int()
	var day = parts[2].to_int()
	if year < 2000 or year > 9999:
		return false
	if month < 1 or month > 12:
		return false
	var max_day = 31
	match month:
		4, 6, 9, 11:
			max_day = 30
		2:
			max_day = 28
			if is_leap_year(year):
				max_day = 29
	if day < 1 or day > max_day:
		return false
	return true


func _to_unix(date_str: String) -> int:
	return Time.get_unix_time_from_datetime_string(date_str + "T00:00:00")


func _get_days_left(expire: String) -> int:
	if not is_valid_date(expire):
		return -2
	var today = Time.get_date_string_from_system(true)
	if not is_valid_date(today):
		return -2
	var t_stamp = _to_unix(today)
	var e_stamp = _to_unix(expire)
	if t_stamp > e_stamp:
		return -1
	return int((e_stamp - t_stamp) / 86400)


# =========================
# 进阶防回拨：检查并更新本地最后运行时间
# =========================
func _check_and_update_last_time(today_str: String) -> bool:
	var current_stamp = _to_unix(today_str)

	if FileAccess.file_exists(TIME_RECORD_PATH):
		var file = FileAccess.open(TIME_RECORD_PATH, FileAccess.READ)
		if file:
			var saved_stamp = file.get_64()
			file.close()
			if current_stamp < saved_stamp:
				return false

	var file = FileAccess.open(TIME_RECORD_PATH, FileAccess.WRITE)
	if file:
		file.store_64(current_stamp)
		file.close()

	return true


# =========================
# 授权评估主逻辑
# 纯函数式：只返回结果，不做任何退出操作
# 供 _ready() 自动校验复用，也供编辑器 Dock 面板展示状态复用
# =========================
func evaluate_license() -> Dictionary:
	var fail := func(code: String) -> Dictionary:
		print("[SYS/Core] %s" % code)
		return {"valid": false, "reason": code, "days_left": -1, "issue": "", "expire": "", "project": ""}

	var path = get_license_path()
	if not FileAccess.file_exists(path):
		return fail.call("Core system initialize failed (Err: 0x011)")

	var raw = read_file(path)
	if raw.is_empty():
		return fail.call("Core system initialize failed (Err: 0x012)")

	var key: PackedByteArray = Marshalls.base64_to_raw(LicenseKeyScript.DERIVED_KEY_B64)
	var decrypted = decrypt(raw, key)
	if decrypted.is_empty():
		return fail.call("Security handshake failed (Err: 0x021)")

	var data = parse_json(decrypted)
	if data.is_empty() or not data.has("expire") or not data.has("issue"):
		return fail.call("Configuration payload invalid (Err: 0x031)")

	var issue_date: String = data["issue"]
	var expire_date: String = data["expire"]
	var project: String = data.get("project", "")

	if project != LicenseKeyScript.PROJECT_CODE:
		return fail.call("Node identity mismatch (Err: 0x033)")

	if not is_valid_date(issue_date) or not is_valid_date(expire_date):
		return fail.call("Timestamp format validation error (Err: 0x032)")

	var today = Time.get_date_string_from_system(true)

	if _to_unix(issue_date) > _to_unix(expire_date):
		return fail.call("Logic sequence anomaly detected (Err: 0x041)")

	if _to_unix(today) < _to_unix(issue_date):
		return fail.call("System clock synchronization fault (Err: 0x051)")

	if not _check_and_update_last_time(today):
		return fail.call("Runtime record mismatch (Err: 0x052)")

	var days_left = _get_days_left(expire_date)
	if days_left < 0:
		return fail.call("Service session expired (Err: 0x099)")

	var expire_parts = expire_date.split("-")
	var mmdd = expire_parts[1] + expire_parts[2]
	var status_code = "%sx%03d" % [mmdd, days_left]
	print("[SYS/Core] Service node # synced successfully (Status: %s)." % status_code)

	return {
		"valid": true,
		"reason": "ok",
		"days_left": days_left,
		"issue": issue_date,
		"expire": expire_date,
		"project": project,
	}


# 兼容旧的调用方式（如果其他脚本里已经在用 check_license()）
func check_license() -> bool:
	return evaluate_license().valid
