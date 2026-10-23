extends SceneTree
##
## headless 入口：godot --headless --path verifier-godot -s run_vectors.gd
## 若设置环境变量 AEGIS_REPORT，结果会同时写入该文件。

const VectorsRunner = preload("res://vectors_runner.gd")
const Verifier = preload("res://aegis_rsa_verify.gd")


func _init() -> void:
	var probe = Verifier.verify_envelope_text("", {}, "vendor-control")
	if typeof(probe) != TYPE_DICTIONARY or not probe.has("ok"):
		print("FATAL verifier 脚本未编译成功")
		quit(1)
		return

	var vectors_path := _find_vectors()
	if vectors_path.is_empty():
		print("FATAL 找不到 vectors.json")
		quit(1)
		return

	var file := FileAccess.open(vectors_path, FileAccess.READ)
	var text := file.get_as_text()
	file.close()

	var runner := VectorsRunner.new()
	runner.run(text)
	_write_report(runner.lines)
	quit(0 if runner.failures == 0 else 1)


func _find_vectors() -> String:
	if FileAccess.file_exists("res://vectors.json"):
		return "res://vectors.json"
	var external := ProjectSettings.globalize_path("res://") + "../../vectors/vectors.json"
	if FileAccess.file_exists(external):
		return external
	return ""


func _write_report(lines: PackedStringArray) -> void:
	var report_path := OS.get_environment("AEGIS_REPORT")
	if report_path.is_empty():
		return
	var report := FileAccess.open(report_path, FileAccess.WRITE)
	if report == null:
		return
	for line in lines:
		report.store_line(line)
	report.close()
