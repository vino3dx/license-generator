@tool
extends Control

const LICENSE_CONFIG_PATH := "res://addons/license_manager/license_config.cfg"
const LicenseManagerScript := preload("res://addons/license_manager/license_manager.gd")

var checkbox: CheckBox
var status_label: Label
var detail_label: RichTextLabel


func _ready() -> void:
	name = "授权"

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 8)
	add_child(vbox)

	var title := Label.new()
	title.text = "License Manager 模块控制"
	title.add_theme_font_size_override("font_size", 16)
	vbox.add_child(title)

	vbox.add_child(HSeparator.new())

	# ==========================================
	# === 【新增】显示 Project ID 与 一键复制按钮 ===
	# ==========================================
	var checker = LicenseManagerScript.new()
	var proj_id: String = checker.get_project_code()

	var id_hbox := HBoxContainer.new()
	id_hbox.add_theme_constant_override("separation", 6)
	vbox.add_child(id_hbox)

	var id_label := Label.new()
	id_label.text = "项目 ID: " + proj_id
	id_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	id_hbox.add_child(id_label)

	var copy_btn := Button.new()
	copy_btn.text = "复制 ID"
	copy_btn.pressed.connect(func():
		DisplayServer.clipboard_set(proj_id)
		copy_btn.text = "已复制!"
		print("【LSM】已成功复制 Project ID 到剪贴板: ", proj_id)
		
		# 1.5 秒后恢复按钮文字
		var timer := get_tree().create_timer(1.5)
		await timer.timeout
		if is_instance_valid(copy_btn):
			copy_btn.text = "复制 ID"
	)
	id_hbox.add_child(copy_btn)

	vbox.add_child(HSeparator.new())

	checkbox = CheckBox.new()
	checkbox.text = "启用授权验证 (License)"
	checkbox.toggled.connect(_on_toggled)
	vbox.add_child(checkbox)

	status_label = Label.new()
	vbox.add_child(status_label)

	vbox.add_child(HSeparator.new())

	var refresh_btn := Button.new()
	refresh_btn.text = "检查当前 license.dat 状态"
	refresh_btn.pressed.connect(_refresh_license_detail)
	vbox.add_child(refresh_btn)

	detail_label = RichTextLabel.new()
	detail_label.fit_content = true
	detail_label.custom_minimum_size = Vector2(0, 130)
	detail_label.bbcode_enabled = true
	vbox.add_child(detail_label)

	_refresh()
	_refresh_license_detail()


func _on_toggled(pressed: bool) -> void:
	var config := ConfigFile.new()
	config.load(LICENSE_CONFIG_PATH)
	config.set_value("license", "enabled", pressed)

	var err := config.save(LICENSE_CONFIG_PATH)
	if err != OK:
		push_error("【LSM】保存配置文件失败: ", err)
	_refresh()


func _refresh() -> void:
	var config := ConfigFile.new()
	var err := config.load(LICENSE_CONFIG_PATH)
	var enabled: bool = true

	if err == OK:
		enabled = config.get_value("license", "enabled", true)
	else:
		config.set_value("license", "enabled", true)
		config.save(LICENSE_CONFIG_PATH)

	checkbox.set_pressed_no_signal(enabled)

	if enabled:
		status_label.text = "● 当前状态: 已启用"
		status_label.add_theme_color_override("font_color", Color(0.3, 0.9, 0.3))
	else:
		status_label.text = "● 当前状态: 已关闭"
		status_label.add_theme_color_override("font_color", Color(0.9, 0.4, 0.4))


func _refresh_license_detail() -> void:
	var checker = LicenseManagerScript.new()
	var result: Dictionary = checker.evaluate_license()

	if result.valid:
		detail_label.text = "[color=#4CE24C]✔ 授权有效[/color]\n项目标识: %s\n签发日期: %s\n到期日期: %s\n剩余天数: %d 天" % [
			result.project, result.issue, result.expire, result.days_left
		]
	else:
		detail_label.text = "[color=#E24C4C]✘ 授权无效 / 未找到[/color]\n原因代码: %s" % result.reason
