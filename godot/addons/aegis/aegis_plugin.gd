@tool
extends EditorPlugin

const AUTOLOAD_NAME := "Aegis"
const AUTOLOAD_PATH := "res://addons/aegis/aegis.gd"
const Dock := preload("res://addons/aegis/aegis_dock.gd")

var _dock: Control


## 启用 / 停用插件时才增删 autoload。
## (旧版在 _exit_tree 里删除 autoload,关闭编辑器时会把它从 project.godot 抹掉,导出的程序就没有校验了)
func _enable_plugin() -> void:
	add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)


func _disable_plugin() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)


func _enter_tree() -> void:
	if not ProjectSettings.has_setting("autoload/" + AUTOLOAD_NAME):
		add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)
	_dock = Dock.new()
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, _dock)


func _exit_tree() -> void:
	if _dock:
		remove_control_from_docks(_dock)
		_dock.queue_free()
		_dock = null
