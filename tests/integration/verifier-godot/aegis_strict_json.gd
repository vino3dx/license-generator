extends RefCounted
##
## Aegis 授权协议 v1 的严格 JSON 解析器（纯 GDScript，无外部依赖）。
##
## 与 TypeScript 实现 src/core/license/strict-json.ts 行为对齐：
## - 拒绝重复键（含嵌套对象）；
## - 数字只接受非负整数：拒绝负号、小数、指数、前导零、超出 2^53-1；
## - 字符串拒绝裸控制字符（< 0x20）与未知转义，`\u` 必须 4 位十六进制；
## - 拒绝孤立代理项（RFC 8259 §8.2 要求成对使用）；
## - 拒绝尾随内容、超深嵌套（> 8）、超长字符串（> 16384 字符）；
## - 解析失败返回稳定错误码，绝不抛异常、绝不返回 null 以外的东西。
##
## 该解析器只负责语法与结构，不做协议字段校验；字段类型与取值由
## aegis_rsa_verify.gd 的 _validate_payload 负责。
##
## 用法：
##   const StrictJson = preload("res://aegis_strict_json.gd")
##   var r := StrictJson.parse(text)
##   if r["ok"]: var value = r["value"]

## 与 strict-json.ts 的 MAX_DEPTH 一致
const MAX_DEPTH := 8
## 与 strict-json.ts 的 MAX_STRING_LENGTH 一致（按字符计，字节上限由信封层负责）
const MAX_STRING_LENGTH := 16 * 1024
## 防御性上限：调用方已按协议限制 16 KiB，这里只防误用
const MAX_INPUT_LENGTH := 64 * 1024
## 2^53 - 1，协议规定的整数上界
const MAX_SAFE_INTEGER := 9007199254740991

const ERR_EMPTY := "json_empty"
const ERR_SYNTAX := "json_syntax"
const ERR_DUPLICATE_KEY := "json_duplicate_key"
const ERR_INVALID_NUMBER := "json_invalid_number"
const ERR_INVALID_ESCAPE := "json_invalid_escape"
const ERR_CONTROL_CHAR := "json_control_char"
const ERR_STRING_TOO_LONG := "json_string_too_long"
const ERR_TOO_DEEP := "json_too_deep"
const ERR_TRAILING_DATA := "json_trailing_data"
const ERR_TOO_LARGE := "json_too_large"


## 解析入口。返回 {ok, error, value, position}
static func parse(text: String) -> Dictionary:
	if text.length() > MAX_INPUT_LENGTH:
		return {"ok": false, "error": ERR_TOO_LARGE, "value": null, "position": 0}
	return _Parser.new(text).parse_document()


##
## 严格 UTF-8 校验（字节级）。
##
## Godot 的 PackedByteArray.get_string_from_utf8() 会把非法字节静默替换为 U+FFFD，
## 因此必须在解码前自行校验，否则非法 UTF-8 会被当作合法文本参与后续判断。
##
## 规则与 Node.js TextDecoder('utf-8', { fatal: true }) 一致：
## - 拒绝 overlong 编码（C0/C1 开头、E0 80、F0 80 等）；
## - 拒绝 UTF-16 代理区（ED A0..BF）；
## - 拒绝超出 U+10FFFF（F4 90 及以上）；
## - 拒绝孤立续字节与截断的多字节序列。
static func is_valid_utf8(bytes: PackedByteArray) -> bool:
	var index := 0
	var size := bytes.size()
	while index < size:
		var byte := bytes[index]
		if byte <= 0x7F:
			index += 1
			continue
		if byte >= 0xC2 and byte <= 0xDF:
			if index + 1 >= size or not _is_continuation(bytes[index + 1]):
				return false
			index += 2
			continue
		if byte == 0xE0:
			if index + 2 >= size:
				return false
			if bytes[index + 1] < 0xA0 or bytes[index + 1] > 0xBF:
				return false
			if not _is_continuation(bytes[index + 2]):
				return false
			index += 3
			continue
		if (byte >= 0xE1 and byte <= 0xEC) or (byte >= 0xEE and byte <= 0xEF):
			if index + 2 >= size:
				return false
			if not _is_continuation(bytes[index + 1]) or not _is_continuation(bytes[index + 2]):
				return false
			index += 3
			continue
		if byte == 0xED:
			# 排除 U+D800..U+DFFF
			if index + 2 >= size:
				return false
			if bytes[index + 1] < 0x80 or bytes[index + 1] > 0x9F:
				return false
			if not _is_continuation(bytes[index + 2]):
				return false
			index += 3
			continue
		if byte == 0xF0:
			if index + 3 >= size:
				return false
			if bytes[index + 1] < 0x90 or bytes[index + 1] > 0xBF:
				return false
			if not _is_continuation(bytes[index + 2]) or not _is_continuation(bytes[index + 3]):
				return false
			index += 4
			continue
		if byte >= 0xF1 and byte <= 0xF3:
			if index + 3 >= size:
				return false
			if (
				not _is_continuation(bytes[index + 1])
				or not _is_continuation(bytes[index + 2])
				or not _is_continuation(bytes[index + 3])
			):
				return false
			index += 4
			continue
		if byte == 0xF4:
			if index + 3 >= size:
				return false
			if bytes[index + 1] < 0x80 or bytes[index + 1] > 0x8F:
				return false
			if not _is_continuation(bytes[index + 2]) or not _is_continuation(bytes[index + 3]):
				return false
			index += 4
			continue
		# 0x80..0xC1、0xF5..0xFF 都是非法起始字节
		return false
	return true


static func _is_continuation(byte: int) -> bool:
	return byte >= 0x80 and byte <= 0xBF


## 递归下降解析器。每次解析新建实例，不使用静态状态，可重入。
class _Parser:
	var text: String
	var size: int
	var index := 0
	var failed := false
	var error_code := ""
	var error_position := 0

	func _init(source: String) -> void:
		text = source
		size = source.length()

	func parse_document() -> Dictionary:
		_skip_whitespace()
		if index >= size:
			return _failure("json_empty")
		var value = _parse_value(0)
		if failed:
			return _failure(error_code)
		_skip_whitespace()
		if index != size:
			return _failure("json_trailing_data")
		return {"ok": true, "error": "", "value": value, "position": index}

	func _failure(code: String) -> Dictionary:
		return {"ok": false, "error": code, "value": null, "position": error_position}

	func _fail(code: String):
		if not failed:
			failed = true
			error_code = code
			error_position = index
		return null

	func _parse_value(depth: int):
		if depth > MAX_DEPTH:
			return _fail("json_too_deep")
		if index >= size:
			return _fail("json_syntax")
		var code := text.unicode_at(index)
		if code == 0x7B: # {
			return _parse_object(depth)
		if code == 0x5B: # [
			return _parse_array(depth)
		if code == 0x22: # "
			return _parse_string()
		if code == 0x74: # t
			return _parse_literal("true", true)
		if code == 0x66: # f
			return _parse_literal("false", false)
		if code == 0x6E: # n
			return _parse_literal("null", null)
		if code >= 0x30 and code <= 0x39: # 0-9
			return _parse_integer()
		if code == 0x2D: # -，协议规定整数无符号
			return _fail("json_invalid_number")
		return _fail("json_syntax")

	func _parse_literal(literal: String, value):
		if not text.substr(index, literal.length()) == literal:
			return _fail("json_syntax")
		index += literal.length()
		return value

	func _parse_object(depth: int):
		index += 1
		var result := {}
		_skip_whitespace()
		if index < size and text.unicode_at(index) == 0x7D: # }
			index += 1
			return result
		while true:
			_skip_whitespace()
			if index >= size or text.unicode_at(index) != 0x22:
				return _fail("json_syntax")
			var key = _parse_string()
			if failed:
				return null
			# 重复键一律拒绝：GDScript Dictionary 的字符串键是值比较，嵌套对象同样覆盖
			if result.has(key):
				return _fail("json_duplicate_key")
			_skip_whitespace()
			if index >= size or text.unicode_at(index) != 0x3A: # :
				return _fail("json_syntax")
			index += 1
			_skip_whitespace()
			var value = _parse_value(depth + 1)
			if failed:
				return null
			result[key] = value
			_skip_whitespace()
			if index >= size:
				return _fail("json_syntax")
			var next_code := text.unicode_at(index)
			if next_code == 0x2C: # ,
				index += 1
				continue
			if next_code == 0x7D: # }
				index += 1
				return result
			return _fail("json_syntax")

	func _parse_array(depth: int):
		index += 1
		var result := []
		_skip_whitespace()
		if index < size and text.unicode_at(index) == 0x5D: # ]
			index += 1
			return result
		while true:
			_skip_whitespace()
			var value = _parse_value(depth + 1)
			if failed:
				return null
			result.append(value)
			_skip_whitespace()
			if index >= size:
				return _fail("json_syntax")
			var next_code := text.unicode_at(index)
			if next_code == 0x2C: # ,
				index += 1
				continue
			if next_code == 0x5D: # ]
				index += 1
				return result
			return _fail("json_syntax")

	func _parse_string():
		index += 1
		var result := ""
		while true:
			if index >= size:
				return _fail("json_syntax")
			var code := text.unicode_at(index)
			if code == 0x22: # "
				index += 1
				return result
			if code == 0x5C: # \
				var escaped = _parse_escape()
				if failed:
					return null
				result += escaped
			else:
				if code < 0x20:
					return _fail("json_control_char")
				result += String.chr(code)
				index += 1
			if result.length() > MAX_STRING_LENGTH:
				return _fail("json_string_too_long")

	func _parse_escape():
		if index + 1 >= size:
			return _fail("json_invalid_escape")
		var code := text.unicode_at(index + 1)
		index += 2
		match code:
			0x22:
				return "\""
			0x5C:
				return "\\"
			0x2F:
				return "/"
			0x62:
				return "\b"
			0x66:
				return "\f"
			0x6E:
				return "\n"
			0x72:
				return "\r"
			0x74:
				return "\t"
			0x75:
				return _parse_unicode_escape()
			_:
				return _fail("json_invalid_escape")

	## \uXXXX；代理项必须成对出现，否则拒绝（与 Node 端修正后行为一致）
	func _parse_unicode_escape():
		var high = _read_hex4()
		if failed:
			return null
		if high >= 0xD800 and high <= 0xDBFF:
			if index + 1 >= size:
				return _fail("json_invalid_escape")
			if text.unicode_at(index) != 0x5C or text.unicode_at(index + 1) != 0x75:
				return _fail("json_invalid_escape")
			index += 2
			var low = _read_hex4()
			if failed:
				return null
			if low < 0xDC00 or low > 0xDFFF:
				return _fail("json_invalid_escape")
			var combined = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)
			return String.chr(combined)
		if high >= 0xDC00 and high <= 0xDFFF:
			return _fail("json_invalid_escape")
		return String.chr(high)

	func _read_hex4():
		if index + 4 > size:
			return _fail("json_invalid_escape")
		var value := 0
		for offset in range(4):
			var code := text.unicode_at(index + offset)
			var digit := -1
			if code >= 0x30 and code <= 0x39:
				digit = code - 0x30
			elif code >= 0x41 and code <= 0x46:
				digit = code - 0x41 + 10
			elif code >= 0x61 and code <= 0x66:
				digit = code - 0x61 + 10
			if digit < 0:
				return _fail("json_invalid_escape")
			value = (value << 4) | digit
		index += 4
		return value

	## 数字：只接受 0 或 [1-9][0-9]*，范围 0..2^53-1
	func _parse_integer():
		var start := index
		while index < size:
			var code := text.unicode_at(index)
			if code < 0x30 or code > 0x39:
				break
			index += 1
		var raw := text.substr(start, index - start)
		if raw.is_empty():
			return _fail("json_syntax")
		# 小数或指数：协议只允许整数，这里给出明确错误码而不是留给外层语法错误
		if index < size:
			var next_code := text.unicode_at(index)
			if next_code == 0x2E or next_code == 0x65 or next_code == 0x45: # . e E
				return _fail("json_invalid_number")
		if raw.length() > 1 and raw.unicode_at(0) == 0x30:
			return _fail("json_invalid_number")
		# 16 位十进制一定超出 2^53-1，先挡住再转 int，避免 to_int 饱和
		if raw.length() > 16:
			return _fail("json_invalid_number")
		var value := raw.to_int()
		if value > MAX_SAFE_INTEGER:
			return _fail("json_invalid_number")
		return value

	func _skip_whitespace() -> void:
		while index < size:
			var code := text.unicode_at(index)
			if code == 0x20 or code == 0x09 or code == 0x0A or code == 0x0D:
				index += 1
			else:
				return
