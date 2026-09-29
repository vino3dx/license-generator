extends RefCounted
## Aegis 授权核心逻辑 (纯静态,不依赖节点;运行时 autoload 与编辑器 Dock 共用)
## 流程: 读文件 → AES-256-CBC 解密 → JSON → 项目匹配 → 日期 / 时钟检查
## 日期规则: 全部使用【本机本地日期】;到期日当天 24:00 前仍有效,次日起失效。

const Secret := preload("res://addons/aegis/aegis_secret.gd")
const CONFIG_PATH := "res://addons/aegis/aegis.cfg"
const RECORD_PATH := "user://aegis_time.dat" # 上次运行时间记录(防回拨系统时钟)
const ROLLBACK_TOLERANCE := 21600 # 允许系统时钟回拨的秒数 (6 小时)


## 项目 ID = sha256(工程名 + 密钥) 前 10 位。生成器端用同一算法。
static func project_code() -> String:
	var proj_name: String = ProjectSettings.get_setting("application/config/name")
	return (proj_name + Secret.SHARED_SECRET).sha256_text().substr(0, 10)


## 密钥指纹(前 8 位),用于和生成器界面对比,快速判断两端密钥是否一致
static func secret_fingerprint() -> String:
	return Secret.SHARED_SECRET.sha256_text().substr(0, 8)


## 导出标记: 粘贴进导出预设的"商标"字段后,生成器读取 exe 即可自动获得项目 ID 与密钥指纹
static func export_tag() -> String:
	return "AG-%s-%s" % [project_code(), secret_fingerprint()]


## 编辑器里可通过 aegis.cfg 关闭校验;导出后的程序【始终强制校验】,不读取该开关
static func is_enabled() -> bool:
	if not OS.has_feature("editor"):
		return true
	var cfg := ConfigFile.new()
	if cfg.load(CONFIG_PATH) != OK:
		return true
	return bool(cfg.get_value("license", "enabled", true))


static func license_path() -> String:
	if OS.has_feature("editor"):
		return ProjectSettings.globalize_path("res://").path_join("license.dat")
	return OS.get_executable_path().get_base_dir().path_join("license.dat")


static func today_string() -> String:
	var d := Time.get_date_dict_from_system(false)
	return "%04d-%02d-%02d" % [d.year, d.month, d.day]


static func _read_text(path: String) -> String:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var txt := f.get_as_text()
	f.close()
	return txt.replace("\ufeff", "").replace("\n", "").replace("\r", "").replace("\t", "").replace(" ", "")


## AES-256-CBC 解密。格式: base64( IV(16) + 密文 ),PKCS7 填充。失败返回空串。
static func decrypt(base64_text: String, key: PackedByteArray) -> String:
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
	if aes.start(AESContext.MODE_CBC_DECRYPT, key, iv) != OK:
		return ""
	var decrypted: PackedByteArray = aes.update(encrypted)
	aes.finish()
	if decrypted.size() == 0:
		return ""
	var pad_len: int = decrypted[decrypted.size() - 1]
	if pad_len < 1 or pad_len > 16 or pad_len > decrypted.size():
		return ""
	for i in range(pad_len):
		if decrypted[decrypted.size() - 1 - i] != pad_len:
			return ""
	return decrypted.slice(0, decrypted.size() - pad_len).get_string_from_utf8()


static func is_valid_date(s: String) -> bool:
	var re := RegEx.new()
	re.compile("^\\d{4}-\\d{2}-\\d{2}$")
	if re.search(s) == null:
		return false
	var parts := s.split("-")
	var year := parts[0].to_int()
	var month := parts[1].to_int()
	var day := parts[2].to_int()
	if year < 2000 or month < 1 or month > 12 or day < 1:
		return false
	var max_day := 31
	match month:
		4, 6, 9, 11:
			max_day = 30
		2:
			var leap := (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)
			max_day = 29 if leap else 28
	return day <= max_day


static func _to_unix(date_str: String) -> int:
	return Time.get_unix_time_from_datetime_string(date_str + "T00:00:00")


@warning_ignore("integer_division")
static func days_between(from_date: String, to_date: String) -> int:
	return (_to_unix(to_date) - _to_unix(from_date)) / 86400


static func _record_checksum(stamp: int) -> String:
	return ("%d|%s|%s" % [stamp, Secret.SHARED_SECRET, project_code()]).sha256_text().substr(0, 16)


## 读取上次运行时间戳;文件不存在 / 损坏 / 被改动 → 返回 0(视为无记录,不误伤客户)
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


## 时钟检查: 当前时间明显早于上次记录 → 判定为回拨。只前进不后退地更新记录。
## 写记录失败(只读目录等)不影响授权结果。
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
	return r


## 主入口。返回 {valid, code, days_left, issue, expire, project, customer, license_id}
## 错误码: 0x011 无文件 | 0x012 空文件 | 0x021 解密失败 | 0x031 内容无效 | 0x032 日期格式
##        0x033 项目不匹配 | 0x041 到期早于签发 | 0x051 系统日期早于签发
##        0x052 时钟被回拨 | 0x099 已到期
## update_record=false 时不写时间记录(编辑器 Dock 查看状态用)
static func evaluate(update_record: bool = true) -> Dictionary:
	var pc := project_code()
	var r := {"valid": false, "code": "", "days_left": -1, "issue": "", "expire": "", "project": pc, "customer": "", "license_id": ""}
	var path := license_path()
	if not FileAccess.file_exists(path):
		return _fail(r, "0x011")
	var raw := _read_text(path)
	if raw.is_empty():
		return _fail(r, "0x012")
	var key: PackedByteArray = (pc + Secret.SHARED_SECRET).sha256_buffer()
	var plain := decrypt(raw, key)
	if plain.is_empty():
		return _fail(r, "0x021")
	var data: Variant = JSON.parse_string(plain)
	if typeof(data) != TYPE_DICTIONARY:
		return _fail(r, "0x031")
	var d: Dictionary = data
	if typeof(d.get("issue")) != TYPE_STRING or typeof(d.get("expire")) != TYPE_STRING:
		return _fail(r, "0x031")
	var issue: String = d["issue"]
	var expire: String = d["expire"]
	r.issue = issue
	r.expire = expire
	r.customer = str(d.get("customer", ""))
	r.license_id = str(d.get("license_id", ""))
	if str(d.get("project", "")) != pc:
		return _fail(r, "0x033")
	if not is_valid_date(issue) or not is_valid_date(expire):
		return _fail(r, "0x032")
	if issue > expire: # ISO 日期,字符串比较即时间先后
		return _fail(r, "0x041")
	var today := today_string()
	if today < issue:
		return _fail(r, "0x051")
	if not _clock_ok(update_record):
		return _fail(r, "0x052")
	if today > expire:
		return _fail(r, "0x099")
	r.days_left = days_between(today, expire)
	r.valid = true
	r.code = "0x000"
	return r
