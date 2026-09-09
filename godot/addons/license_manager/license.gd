@tool
extends EditorPlugin

const LICENSE_SINGLETON := "LicenseManager"
const LICENSE_SCRIPT := "res://addons/license_manager/license_manager.gd"
const DOCK_SCRIPT := "res://addons/license_manager/license_dock.gd"

var dock: Control

func _enter_tree() -> void:
	if not ProjectSettings.has_setting("autoload/" + LICENSE_SINGLETON):
		add_autoload_singleton(LICENSE_SINGLETON, LICENSE_SCRIPT)

	dock = preload(DOCK_SCRIPT).new()
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, dock)

	print("【LicenseManager】已成功加载至 Editor Dock")

func _exit_tree() -> void:
	if ProjectSettings.has_setting("autoload/" + LICENSE_SINGLETON):
		remove_autoload_singleton(LICENSE_SINGLETON)
	if dock:
		remove_control_from_docks(dock)
		dock.queue_free()
