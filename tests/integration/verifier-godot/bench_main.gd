extends Node
##
## 导出后（Release 模板）的主场景：跑同一套向量，把结果写文件后退出。
## 输出路径取 AEGIS_REPORT，未设置时写到 user://vectors_report.txt。

const VectorsRunner = preload("res://vectors_runner.gd")


func _ready() -> void:
	var path := "res://vectors.json"
	if not FileAccess.file_exists(path):
		print("FATAL 导出包内缺少 vectors.json")
		get_tree().quit(1)
		return
	var file := FileAccess.open(path, FileAccess.READ)
	var text := file.get_as_text()
	file.close()

	var runner := VectorsRunner.new()
	runner.run(text)

	var report_path := OS.get_environment("AEGIS_REPORT")
	if report_path.is_empty():
		report_path = ProjectSettings.globalize_path("user://vectors_report.txt")
	var report := FileAccess.open(report_path, FileAccess.WRITE)
	if report == null:
		print("FATAL 无法写入报告: " + report_path)
		get_tree().quit(1)
		return
	for line in runner.lines:
		report.store_line(line)
	report.close()
	print("REPORT " + report_path)
	get_tree().quit(0 if runner.failures == 0 else 1)
