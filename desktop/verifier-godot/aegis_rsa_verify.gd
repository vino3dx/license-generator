extends RefCounted
##
## Aegis 授权协议 v1 的子机侧验签器（纯 GDScript，无原生依赖）。
##
## 设计约束（与 docs/license-protocol.md 一致）：
## - 只用 modulus / exponent 表示公钥，不解析 PEM / DER，也不调用 CryptoKey；
## - 只做验签（公钥运算），不包含任何私钥或私钥运算；
## - 校验失败一律返回错误码字符串，不抛异常、不 return null；
## - 文件自包含（无 class_name、无 autoload、无外部依赖），便于后续整体复制进 Godot 插件。
##
## 用法：
##   const AegisRsaVerifier = preload("res://aegis_rsa_verify.gd")
##   var result := AegisRsaVerifier.verify_envelope_text(envelope_text, public_key_dict, "vendor-control")
##   if result["ok"]: var payload: Dictionary = result["payload"]

const ENVELOPE_MARKER := "license-envelope"
const SCHEMA_VERSION := 1
const ALGORITHM := "RS256"
const MAX_ENVELOPE_BYTES := 16384
const MAX_PAYLOAD_BYTES := 8192
const MODULUS_BYTES := 256
const SIGNATURE_BYTES := 256
const MIN_EXPONENT := 65537

const LIMBS := 128
const LIMB_BITS := 16
const LIMB_MASK := 0xFFFF
const LIMB_BASE := 0x10000

const DIGEST_INFO_SHA256_HEX := "3031300d060960864801650304020105000420"
const TYPE_VENDOR := "vendor-control"
const TYPE_MACHINE := "machine-license"

## 严格 JSON 解析器（拒绝重复键、非法数字、非法 UTF-8 等），与 Node 端行为对齐
const StrictJson = preload("res://aegis_strict_json.gd")

const ENVELOPE_KEYS := ["aegis", "schema_version", "license_type", "alg", "kid", "payload", "signature"]
const PUBLIC_KEY_KEYS := ["kty", "n", "e"]
const VENDOR_PAYLOAD_KEYS := [
	"schema_version",
	"license_type",
	"license_id",
	"issued_at",
	"expires_at",
	"project_ids",
	"max_devices",
	"features",
	"delegated_public_key",
]
const MACHINE_PAYLOAD_KEYS := [
	"schema_version",
	"license_type",
	"license_id",
	"control_license_id",
	"project_id",
	"device_id",
	"issued_at",
	"expires_at",
	"status",
	"features",
]

static var _key_cache: Dictionary = {}
static var _identifier_regex: RegEx = null
static var _timestamp_regex: RegEx = null


## 校验结果：{ "ok": bool, "error": String, "detail": String, "payload": Dictionary, "license_type": String }
##
## 字节入口：用于从文件读取的原始内容。会先做严格 UTF-8 校验，
## 避免 Godot 把非法字节替换成 U+FFFD 后当作合法文本继续处理。
static func verify_envelope_bytes(
	bytes: PackedByteArray, public_key: Dictionary, expected_type: String
) -> Dictionary:
	if bytes.is_empty():
		return _failure("invalid_input")
	if bytes.size() > MAX_ENVELOPE_BYTES:
		return _failure("envelope_too_large")
	if not StrictJson.is_valid_utf8(bytes):
		return _failure("envelope_malformed", "json_invalid_utf8")
	return verify_envelope_text(bytes.get_string_from_utf8(), public_key, expected_type)


static func verify_envelope_text(text: String, public_key: Dictionary, expected_type: String) -> Dictionary:
	if typeof(text) != TYPE_STRING or text.is_empty():
		return _failure("invalid_input")
	if expected_type != TYPE_VENDOR and expected_type != TYPE_MACHINE:
		return _failure("invalid_input")
	if text.to_utf8_buffer().size() > MAX_ENVELOPE_BYTES:
		return _failure("envelope_too_large")

	var trimmed := text.strip_edges()
	if not trimmed.begins_with("{") or not trimmed.ends_with("}"):
		return _failure("envelope_malformed")

	# 信封本身不签名，但仍按协议拒绝重复键与尾随内容，避免 aegis/kid 等字段出现歧义
	var parsed := StrictJson.parse(trimmed)
	if not parsed["ok"]:
		return _failure("envelope_malformed", String(parsed["error"]))
	var envelope = parsed["value"]
	if typeof(envelope) != TYPE_DICTIONARY:
		return _failure("envelope_malformed")

	if not _has_exact_keys(envelope, ENVELOPE_KEYS):
		return _failure("envelope_malformed")
	if envelope["aegis"] != ENVELOPE_MARKER:
		return _failure("envelope_malformed")
	if typeof(envelope["schema_version"]) != TYPE_FLOAT and typeof(envelope["schema_version"]) != TYPE_INT:
		return _failure("envelope_malformed")
	if int(envelope["schema_version"]) != SCHEMA_VERSION:
		return _failure("unsupported_version")
	if envelope["alg"] != ALGORITHM:
		return _failure("unsupported_algorithm")
	if typeof(envelope["license_type"]) != TYPE_STRING or envelope["license_type"] != expected_type:
		return _failure("type_mismatch")
	if typeof(envelope["kid"]) != TYPE_STRING or envelope["kid"].is_empty():
		return _failure("envelope_malformed")
	if typeof(envelope["payload"]) != TYPE_STRING or typeof(envelope["signature"]) != TYPE_STRING:
		return _failure("envelope_malformed")

	var payload_decode := _decode_base64url(envelope["payload"])
	if not payload_decode["ok"]:
		return _failure("base64url_invalid")
	var payload_bytes: PackedByteArray = payload_decode["bytes"]
	if payload_bytes.is_empty():
		return _failure("envelope_malformed")
	if payload_bytes.size() > MAX_PAYLOAD_BYTES:
		return _failure("payload_too_large")

	var signature_decode := _decode_base64url(envelope["signature"])
	if not signature_decode["ok"]:
		return _failure("base64url_invalid")
	var signature_bytes: PackedByteArray = signature_decode["bytes"]
	if signature_bytes.size() != SIGNATURE_BYTES:
		return _failure("signature_length")

	var verify_error := _verify_signature(payload_bytes, signature_bytes, public_key)
	if not verify_error.is_empty():
		return _failure(verify_error)

	# 验签通过后才解析 payload：先做字节级 UTF-8 校验，再做严格 JSON 解析
	if not StrictJson.is_valid_utf8(payload_bytes):
		return _failure("payload_malformed", "json_invalid_utf8")
	var payload_parsed := StrictJson.parse(payload_bytes.get_string_from_utf8())
	if not payload_parsed["ok"]:
		return _failure("payload_malformed", String(payload_parsed["error"]))
	var payload = payload_parsed["value"]
	if typeof(payload) != TYPE_DICTIONARY:
		return _failure("payload_malformed")

	var payload_error := _validate_payload(payload, expected_type)
	if not payload_error.is_empty():
		return _failure(payload_error)

	return {"ok": true, "error": "", "detail": "", "payload": payload, "license_type": expected_type}


## 供调用方在拿到 payload 后继续校验：项目是否在范围内（"*" 表示不限）
static func is_project_allowed(vendor_payload: Dictionary, project_id: String) -> bool:
	var scope = vendor_payload.get("project_ids")
	if typeof(scope) != TYPE_ARRAY:
		return false
	for item in scope:
		if item == "*" or item == project_id:
			return true
	return false


## 清空公钥预计算缓存（测试与基准测量用）
static func reset_cache() -> void:
	_key_cache.clear()


## 公开的诊断入口：返回给定公钥的 Montgomery 预计算量，供交叉校验使用
static func public_key_diagnostics(public_key: Dictionary) -> Dictionary:
	var prepared := _prepare_public_key(public_key)
	if not prepared["ok"]:
		return {"ok": false}
	return {
		"ok": true,
		"n0inv": prepared["n0inv"],
		"r2_hex": _limbs_to_hex(prepared["r2"]),
	}


static func _failure(code: String, detail: String = "") -> Dictionary:
	return {"ok": false, "error": code, "detail": detail, "payload": {}, "license_type": ""}


static func _has_exact_keys(value: Dictionary, expected: Array) -> bool:
	if value.keys().size() != expected.size():
		return false
	for key in expected:
		if not value.has(key):
			return false
	return true


## 严格 Base64URL 解码：拒绝填充符、非法字符、长度 %4==1 与非规范尾部位
static func _decode_base64url(text: String) -> Dictionary:
	if typeof(text) != TYPE_STRING or text.is_empty():
		return {"ok": false}
	if text.length() % 4 == 1:
		return {"ok": false}
	var output := PackedByteArray()
	var buffer := 0
	var bits := 0
	for index in range(text.length()):
		var code := text.unicode_at(index)
		var value := -1
		if code >= 65 and code <= 90:
			value = code - 65
		elif code >= 97 and code <= 122:
			value = code - 71
		elif code >= 48 and code <= 57:
			value = code + 4
		elif code == 45:
			value = 62
		elif code == 95:
			value = 63
		else:
			return {"ok": false}
		buffer = (buffer << 6) | value
		bits += 6
		if bits >= 8:
			bits -= 8
			output.append((buffer >> bits) & 0xFF)
			buffer = buffer & ((1 << bits) - 1)
	if bits > 0 and buffer != 0:
		return {"ok": false}
	return {"ok": true, "bytes": output}


static func _verify_signature(message: PackedByteArray, signature: PackedByteArray, public_key: Dictionary) -> String:
	var prepared := _prepare_public_key(public_key)
	if not prepared["ok"]:
		return "key_invalid"

	var modulus: PackedInt32Array = prepared["modulus"]
	if signature.size() != MODULUS_BYTES:
		return "signature_length"
	var signature_value := _limbs_from_bytes_be(signature)
	if _compare(signature_value, modulus) >= 0:
		return "signature_out_of_range"

	var digest := _sha256(message)
	var recovered := _mod_pow(signature_value, int(prepared["exponent"]), prepared)
	if _compare(recovered, _expected_em_limbs(digest)) != 0:
		return "signature_invalid"
	return ""


static func _prepare_public_key(public_key) -> Dictionary:
	if typeof(public_key) != TYPE_DICTIONARY:
		return {"ok": false}
	if not _has_exact_keys(public_key, PUBLIC_KEY_KEYS):
		return {"ok": false}
	if public_key["kty"] != "RSA":
		return {"ok": false}
	if typeof(public_key["n"]) != TYPE_STRING or typeof(public_key["e"]) != TYPE_STRING:
		return {"ok": false}

	var cache_key: String = String(public_key["n"]) + "|" + String(public_key["e"])
	if _key_cache.has(cache_key):
		return _key_cache[cache_key]

	var modulus_decode := _decode_base64url(public_key["n"])
	if not modulus_decode["ok"]:
		return {"ok": false}
	var modulus_bytes: PackedByteArray = modulus_decode["bytes"]
	if modulus_bytes.size() != MODULUS_BYTES:
		return {"ok": false}
	if modulus_bytes[0] < 0x80:
		return {"ok": false}
	if modulus_bytes[MODULUS_BYTES - 1] % 2 == 0:
		return {"ok": false}

	var exponent_decode := _decode_base64url(public_key["e"])
	if not exponent_decode["ok"]:
		return {"ok": false}
	var exponent_bytes: PackedByteArray = exponent_decode["bytes"]
	if exponent_bytes.size() < 1 or exponent_bytes.size() > 4:
		return {"ok": false}
	var exponent := 0
	for byte in exponent_bytes:
		exponent = (exponent << 8) | byte
	if exponent % 2 == 0 or exponent < MIN_EXPONENT:
		return {"ok": false}

	var modulus := _limbs_from_bytes_be(modulus_bytes)
	var prepared := {
		"ok": true,
		"modulus": modulus,
		"exponent": exponent,
		"n0inv": _compute_n0inv(modulus),
		"r2": _compute_r2(modulus),
	}
	_key_cache[cache_key] = prepared
	return prepared


static func _compute_n0inv(modulus: PackedInt32Array) -> int:
	var n0: int = modulus[0] & LIMB_MASK
	var inverse := 1
	for _iteration in range(4):
		inverse = (inverse * (2 - ((n0 * inverse) & LIMB_MASK))) & LIMB_MASK
	return (LIMB_BASE - inverse) & LIMB_MASK


## R² mod n = 2^4096 mod n，用 4096 次模加倍得到（每把公钥只算一次并缓存）
static func _compute_r2(modulus: PackedInt32Array) -> PackedInt32Array:
	var value := _limbs_one()
	for _step in range(LIMBS * LIMB_BITS * 2):
		value = _double_mod(value, modulus)
	return value


static func _double_mod(value: PackedInt32Array, modulus: PackedInt32Array) -> PackedInt32Array:
	var doubled := PackedInt32Array()
	doubled.resize(LIMBS)
	doubled.fill(0)
	var carry := 0
	for index in range(LIMBS):
		var shifted: int = (value[index] << 1) | carry
		doubled[index] = shifted & LIMB_MASK
		carry = shifted >> LIMB_BITS
	if carry != 0 or _compare(doubled, modulus) >= 0:
		doubled = _subtract(doubled, modulus)
	return doubled


static func _mod_pow(base: PackedInt32Array, exponent: int, prepared: Dictionary) -> PackedInt32Array:
	var modulus: PackedInt32Array = prepared["modulus"]
	var n0inv: int = prepared["n0inv"]
	var r2: PackedInt32Array = prepared["r2"]
	var base_mont := _mont_mul(base, r2, modulus, n0inv)
	var accumulator := _mont_mul(_limbs_one(), r2, modulus, n0inv)
	var started := false
	for bit in range(31, -1, -1):
		var bit_set := ((exponent >> bit) & 1) == 1
		if not started:
			if not bit_set:
				continue
			started = true
			accumulator = base_mont
			continue
		accumulator = _mont_mul(accumulator, accumulator, modulus, n0inv)
		if bit_set:
			accumulator = _mont_mul(accumulator, base_mont, modulus, n0inv)
	return _mont_mul(accumulator, _limbs_one(), modulus, n0inv)


## Montgomery 乘法（CIOS），16 位分肢体；与 Node.js BigInt 实现交叉验证过
static func _mont_mul(a: PackedInt32Array, b: PackedInt32Array, modulus: PackedInt32Array, n0inv: int) -> PackedInt32Array:
	var t := PackedInt32Array()
	t.resize(LIMBS + 2)
	t.fill(0)

	for i in range(LIMBS):
		var carry := 0
		var b_limb: int = b[i]
		for j in range(LIMBS):
			var uv: int = t[j] + a[j] * b_limb + carry
			t[j] = uv & LIMB_MASK
			carry = uv >> LIMB_BITS
		var top: int = t[LIMBS] + carry
		t[LIMBS] = top & LIMB_MASK
		t[LIMBS + 1] = top >> LIMB_BITS

		var multiplier: int = (t[0] * n0inv) & LIMB_MASK
		var reduce: int = t[0] + multiplier * modulus[0]
		carry = reduce >> LIMB_BITS
		for j in range(1, LIMBS):
			var uv2: int = t[j] + multiplier * modulus[j] + carry
			t[j - 1] = uv2 & LIMB_MASK
			carry = uv2 >> LIMB_BITS
		var last: int = t[LIMBS] + carry
		t[LIMBS - 1] = last & LIMB_MASK
		t[LIMBS] = t[LIMBS + 1] + (last >> LIMB_BITS)

	var result := PackedInt32Array()
	result.resize(LIMBS)
	for i in range(LIMBS):
		result[i] = t[i]
	if _compare(result, modulus) >= 0:
		result = _subtract(result, modulus)
	return result


static func _expected_em_limbs(digest: PackedByteArray) -> PackedInt32Array:
	var digest_info: PackedByteArray = DIGEST_INFO_SHA256_HEX.hex_decode()
	var em := PackedByteArray()
	em.resize(MODULUS_BYTES)
	em.fill(0)
	em[0] = 0x00
	em[1] = 0x01
	var zero_index := MODULUS_BYTES - digest_info.size() - digest.size() - 1
	for index in range(2, zero_index):
		em[index] = 0xFF
	em[zero_index] = 0x00
	for index in range(digest_info.size()):
		em[zero_index + 1 + index] = digest_info[index]
	for index in range(digest.size()):
		em[zero_index + 1 + digest_info.size() + index] = digest[index]
	return _limbs_from_bytes_be(em)


static func _sha256(data: PackedByteArray) -> PackedByteArray:
	var context := HashingContext.new()
	context.start(HashingContext.HASH_SHA256)
	context.update(data)
	return context.finish()


static func _limbs_one() -> PackedInt32Array:
	var value := PackedInt32Array()
	value.resize(LIMBS)
	value.fill(0)
	value[0] = 1
	return value


static func _limbs_from_bytes_be(bytes: PackedByteArray) -> PackedInt32Array:
	var limbs := PackedInt32Array()
	limbs.resize(LIMBS)
	limbs.fill(0)
	var length := bytes.size()
	for index in range(LIMBS):
		var low_index := length - 1 - 2 * index
		var high_index := length - 2 - 2 * index
		var low := 0
		var high := 0
		if low_index >= 0:
			low = bytes[low_index]
		if high_index >= 0:
			high = bytes[high_index]
		limbs[index] = low | (high << 8)
	return limbs


static func _limbs_to_hex(limbs: PackedInt32Array) -> String:
	var bytes := PackedByteArray()
	bytes.resize(LIMBS * 2)
	for index in range(LIMBS):
		bytes[LIMBS * 2 - 1 - 2 * index] = limbs[index] & 0xFF
		bytes[LIMBS * 2 - 2 - 2 * index] = (limbs[index] >> 8) & 0xFF
	return bytes.hex_encode()


static func _compare(a: PackedInt32Array, b: PackedInt32Array) -> int:
	for index in range(LIMBS - 1, -1, -1):
		if a[index] > b[index]:
			return 1
		if a[index] < b[index]:
			return -1
	return 0


static func _subtract(a: PackedInt32Array, b: PackedInt32Array) -> PackedInt32Array:
	var result := PackedInt32Array()
	result.resize(LIMBS)
	result.fill(0)
	var borrow := 0
	for index in range(LIMBS):
		var difference: int = a[index] - b[index] - borrow
		if difference < 0:
			difference += LIMB_BASE
			borrow = 1
		else:
			borrow = 0
		result[index] = difference
	return result


static func _validate_payload(payload: Dictionary, expected_type: String) -> String:
	var expected_keys: Array = VENDOR_PAYLOAD_KEYS if expected_type == TYPE_VENDOR else MACHINE_PAYLOAD_KEYS
	if not _has_exact_keys(payload, expected_keys):
		return "payload_invalid"

	var version = payload["schema_version"]
	if typeof(version) != TYPE_FLOAT and typeof(version) != TYPE_INT:
		return "payload_invalid"
	if int(version) != SCHEMA_VERSION:
		return "unsupported_version"

	if typeof(payload["license_type"]) != TYPE_STRING or payload["license_type"] != expected_type:
		return "type_mismatch"
	if not _is_identifier(payload["license_id"]):
		return "payload_invalid"
	if not _is_timestamp(payload["issued_at"]) or not _is_timestamp(payload["expires_at"]):
		return "payload_invalid"
	if _parse_time(payload["expires_at"]) <= _parse_time(payload["issued_at"]):
		return "payload_invalid"
	if not _validate_string_list(payload["features"], false):
		return "payload_invalid"

	if expected_type == TYPE_VENDOR:
		if not _validate_string_list(payload["project_ids"], true) or (payload["project_ids"] as Array).is_empty():
			return "payload_invalid"
		var max_devices = payload["max_devices"]
		if typeof(max_devices) != TYPE_FLOAT and typeof(max_devices) != TYPE_INT:
			return "payload_invalid"
		if int(max_devices) != max_devices or int(max_devices) < 1 or int(max_devices) > 1000000:
			return "payload_invalid"
		if typeof(payload["delegated_public_key"]) != TYPE_DICTIONARY:
			return "payload_invalid"
		if not _prepare_public_key(payload["delegated_public_key"])["ok"]:
			return "key_invalid"
	else:
		for field in ["control_license_id", "project_id", "device_id"]:
			if not _is_identifier(payload[field]):
				return "payload_invalid"
		if typeof(payload["status"]) != TYPE_STRING or (payload["status"] != "active" and payload["status"] != "revoked"):
			return "payload_invalid"
	return ""


static func _validate_string_list(value, allow_wildcard: bool) -> bool:
	if typeof(value) != TYPE_ARRAY:
		return false
	var seen := {}
	for item in value:
		if typeof(item) != TYPE_STRING:
			return false
		if allow_wildcard and item == "*":
			seen[item] = true
			continue
		if not _is_identifier(item):
			return false
		if seen.has(item):
			return false
		seen[item] = true
	if allow_wildcard and seen.has("*") and value.size() > 1:
		return false
	return true


static func _is_identifier(value) -> bool:
	if typeof(value) != TYPE_STRING:
		return false
	if _identifier_regex == null:
		_identifier_regex = RegEx.create_from_string("^[A-Za-z0-9._:-]{1,128}$")
	return _identifier_regex.search(value) != null


static func _is_timestamp(value) -> bool:
	if typeof(value) != TYPE_STRING:
		return false
	if _timestamp_regex == null:
		_timestamp_regex = RegEx.create_from_string("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$")
	return _timestamp_regex.search(value) != null


static func _parse_time(value: String) -> int:
	return int(Time.get_unix_time_from_datetime_string(value))
