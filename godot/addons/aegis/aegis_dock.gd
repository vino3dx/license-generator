@tool
extends VBoxContainer
## Aegis 编辑器 Dock: 显示项目 ID / 密钥指纹、开关校验、查看当前 license.dat 状态

const License := preload("res://addons/aegis/aegis_license.gd")
const AUTOLOAD_NAME := "Aegis"
const HINTS := {
	"0x011": "未找到 license.dat (编辑器: 放工程根目录;导出后: 放 exe 同目录)",
	"0x012": "license.dat 为空",
	"0x021": "解密失败: 项目 ID 或密钥与生成器不一致 (对比上方项目 ID / 密钥指纹)",
	"0x031": "授权内容格式不正确",
	"0x032": "授权内的日期格式非法",
	"0x033": "授权的项目 ID 与当前工程不匹配 (是否改过工程名?)",
	"0x041": "到期日期早于签发日期",
	"0x051": "系统日期早于签发日期",
	"0x052": "系统时钟被回拨 (可点下方按钮重置时间记录)",
	"0x099": "授权已到期",
}

var _checkbox: CheckBox
var _status: Label
var _autoload: Label
var _detail: RichTextLabel


func _init() -> void:
	name = "Aegis"


func _ready() -> void:
	add_theme_constant_override("separation", 8)
	var title := Label.new()
	title.text = "Aegis 授权模块 v3.0"
	title.add_theme_font_size_override("font_size", 16)
	add_child(title)
	add_child(HSeparator.new())
	_add_copy_row("项目 ID", License.project_code())
	_add_copy_row("密钥指纹", License.secret_fingerprint())
	_add_copy_row("导出标记", License.export_tag())
	var tip := Label.new()
	tip.text = "导出 → Windows → 应用程序 → 商标(Trademarks) 粘贴「导出标记」,一次即可;生成器读取 exe 就能拿到项目 ID"
	tip.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	tip.add_theme_color_override("font_color", Color(0.6, 0.6, 0.6))
	add_child(tip)
	add_child(HSeparator.new())
	_checkbox = CheckBox.new()
	_checkbox.text = "启用授权验证 (仅编辑器内生效)"
	_checkbox.toggled.connect(_on_toggled)
	add_child(_checkbox)
	_status = Label.new()
	add_child(_status)
	_autoload = Label.new()
	_autoload.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_autoload)
	add_child(HSeparator.new())
	var refresh_btn := Button.new()
	refresh_btn.text = "检查当前 license.dat 状态"
	refresh_btn.pressed.connect(_refresh_license)
	add_child(refresh_btn)
	var reset_btn := Button.new()
	reset_btn.text = "重置时间记录 (仅开发测试用)"
	reset_btn.pressed.connect(_on_reset)
	add_child(reset_btn)
	_detail = RichTextLabel.new()
	_detail.bbcode_enabled = true
	_detail.fit_content = true
	_detail.custom_minimum_size = Vector2(0, 130)
	add_child(_detail)
	_refresh_switch()
	_refresh_license()


func _add_copy_row(title: String, value: String) -> void:
	var row := HBoxContainer.new()
	var lb := Label.new()
	lb.text = "%s: %s" % [title, value]
	lb.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(lb)
	var btn := Button.new()
	btn.text = "复制"
	btn.pressed.connect(_copy.bind(btn, value))
	row.add_child(btn)
	add_child(row)


func _copy(btn: Button, value: String) -> void:
	DisplayServer.clipboard_set(value)
	btn.text = "已复制"
	await get_tree().create_timer(1.5).timeout
	if is_instance_valid(btn):
		btn.text = "复制"


func _on_toggled(pressed: bool) -> void:
	var cfg := ConfigFile.new()
	cfg.load(License.CONFIG_PATH)
	cfg.set_value("license", "enabled", pressed)
	if cfg.save(License.CONFIG_PATH) != OK:
		push_error("[Aegis] 保存 aegis.cfg 失败")
	_refresh_switch()


func _on_reset() -> void:
	License.reset_time_record()
	_refresh_license()


func _refresh_switch() -> void:
	var enabled := License.is_enabled()
	_checkbox.set_pressed_no_signal(enabled)
	_status.text = "● 当前状态: 已启用" if enabled else "● 当前状态: 已关闭 (导出后仍强制校验)"
	_status.add_theme_color_override("font_color", Color(0.3, 0.9, 0.3) if enabled else Color(0.9, 0.4, 0.4))
	var has_autoload := ProjectSettings.has_setting("autoload/" + AUTOLOAD_NAME)
	_autoload.text = "● Autoload: 正常" if has_autoload else "⚠ 未检测到 Aegis autoload,导出的程序将不会校验!请在 项目设置 → 插件 中重新启用 Aegis。"
	_autoload.add_theme_color_override("font_color", Color(0.3, 0.9, 0.3) if has_autoload else Color(1, 0.6, 0.2))


func _refresh_license() -> void:
	var r: Dictionary = License.evaluate(false)
	var path := License.license_path()
	if r.valid:
		_detail.text = "[color=#4CE24C]✔ 授权有效[/color]\n客户: %s\n签发日期: %s\n到期日期: %s (含当天)\n剩余天数: %d 天\n路径: %s" % [r.customer, r.issue, r.expire, r.days_left, path]
	else:
		_detail.text = "[color=#E24C4C]✘ 授权无效[/color]\n错误码: %s\n%s\n路径: %s" % [r.code, HINTS.get(r.code, ""), path]
