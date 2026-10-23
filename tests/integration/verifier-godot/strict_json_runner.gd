extends SceneTree
##
## 严格 JSON 共享向量的 Godot 侧执行入口：
##   godot --headless --path tests/integration/verifier-godot -s strict_json_runner.gd
##
## 读取与 Node 端相同的 tests/vectors/strict-json-cases.json，
## 逐条比对细粒度错误码，任何不一致都以非零退出码结束。

const StrictJson = preload("res://aegis_strict_json.gd")

var lines: PackedStringArray = []
var failures := 0


func _init() -> void:
	var fixture_path := _find_fixture()
	if fixture_path.is_empty():
		print("FATAL 找不到 strict-json-cases.json")
		quit(1)
		return

	var file := FileAccess.open(fixture_path, FileAccess.READ)
	if file == null:
		print("FATAL 无法读取 strict-json-cases.json")
		quit(1)
		return
	var text := file.get_as_text()
	file.close()

	var data = JSON.parse_string(text)
	if typeof(data) != TYPE_DICTIONARY:
		print("FATAL 向量文件不是合法 JSON")
		quit(1)
		return

	_run_json_cases(data["json_cases"])
	_run_utf8_cases(data["utf8_cases"])
	_emit("SUMMARY fail=%d" % failures)
	_write_report()
	quit(0 if failures == 0 else 1)


func _run_json_cases(cases: Array) -> void:
	for entry in cases:
		var case_id := String(entry["id"])
		var input := String(entry["input"])
		var expected := String(entry["expect"])
		var result := StrictJson.parse(input)
		var actual := "ok" if result["ok"] else String(result["error"])
		var passed := actual == expected
		if not passed:
			failures += 1
		_emit(
			"CASE %s %s expected=%s actual=%s pos=%d"
			% [case_id, "PASS" if passed else "FAIL", expected, actual, int(result["position"])]
		)


func _run_utf8_cases(cases: Array) -> void:
	for entry in cases:
		var case_id := String(entry["id"])
		var bytes: PackedByteArray = String(entry["hex"]).hex_decode()
		var expected: bool = bool(entry["valid"])
		var actual := StrictJson.is_valid_utf8(bytes)
		var passed := actual == expected
		if not passed:
			failures += 1
		_emit(
			"UTF8 %s %s expected=%s actual=%s"
			% [case_id, "PASS" if passed else "FAIL", expected, actual]
		)


func _find_fixture() -> String:
	if FileAccess.file_exists("res://strict-json-cases.json"):
		return "res://strict-json-cases.json"
	var external := ProjectSettings.globalize_path("res://") + "../../vectors/strict-json-cases.json"
	if FileAccess.file_exists(external):
		return external
	return ""


func _emit(line: String) -> void:
	lines.append(line)
	print(line)


func _write_report() -> void:
	var report_path := OS.get_environment("AEGIS_REPORT")
	if report_path.is_empty():
		return
	var report := FileAccess.open(report_path, FileAccess.WRITE)
	if report == null:
		return
	for line in lines:
		report.store_line(line)
	report.close()
