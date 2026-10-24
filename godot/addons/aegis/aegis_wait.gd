extends Control
## Aegis 授权等待界面：全屏纯黑 + 居中红色 MM:SS 倒计时。
##
## 只负责显示，不做任何授权判断、不访问网络、不读授权文件内容。
## 由 aegis.gd 在授权无效时创建并逐帧调用 set_remaining()；
## 授权成功后 aegis.gd 负责释放本节点。
##
## 尺寸自适应：铺满整个视口（锚点 FULL_RECT），字号按视口高度比例缩放，
## 因此窗口缩放与全屏切换后仍然居中可见。

const BG_COLOR := Color(0, 0, 0, 1)
const TEXT_COLOR := Color(0.92, 0.12, 0.12, 1)
const MIN_FONT_SIZE := 28
const MAX_FONT_SIZE := 260
const FONT_HEIGHT_RATIO := 0.14

var _label: Label = null
var _last_text := ""


func _ready() -> void:
	# 覆盖层自身必须恒定处理与显示，不受 SceneTree.paused 影响
	process_mode = Node.PROCESS_MODE_ALWAYS
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	# 吃掉全部鼠标事件，防止等待期间被点击穿透到游戏
	mouse_filter = Control.MOUSE_FILTER_STOP

	var background := ColorRect.new()
	background.name = "Background"
	background.color = BG_COLOR
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(background)

	_label = Label.new()
	_label.name = "Countdown"
	_label.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_label.add_theme_color_override("font_color", TEXT_COLOR)
	_label.text = format_seconds(0)
	add_child(_label)

	get_viewport().size_changed.connect(_rescale)
	_rescale()


## 剩余秒数（>=0）。只在文本真正变化时写 Label，避免每帧重建字符串。
func set_remaining(total_seconds: int) -> void:
	var text := format_seconds(total_seconds)
	if text == _last_text:
		return
	_last_text = text
	if is_instance_valid(_label):
		_label.text = text


## 当前显示的文本，供授权管理器与测试读取
func text() -> String:
	return _last_text


## MM:SS，分钟不截断（600 秒 → "10:00"）
static func format_seconds(total_seconds: int) -> String:
	var seconds := maxi(total_seconds, 0)
	return "%02d:%02d" % [seconds / 60, seconds % 60]


func _rescale() -> void:
	if not is_instance_valid(_label):
		return
	var viewport_height := int(get_viewport_rect().size.y)
	var font_size := clampi(
		int(round(float(viewport_height) * FONT_HEIGHT_RATIO)), MIN_FONT_SIZE, MAX_FONT_SIZE
	)
	_label.add_theme_font_size_override("font_size", font_size)
