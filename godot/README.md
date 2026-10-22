# Aegis Godot 插件（`addons/aegis`）

Aegis 中控授权体系在 Godot 客户端的执行组件：用编译期内置的厂商公钥验证中控主机签发的
`control.cert`，再用证书里的委托公钥验证子机授权 `license.dat`；任何一步失败都会暂停场景、
提示错误码并以退出码 1 结束进程。

协议定义见 `desktop/docs/license-protocol.md`（`aegis-license/v1`，RS256）。

> 当前状态：验签链路、失败拦截、分发包与干净工程安装已验证；
> **厂商公钥仍为空占位，生产授权链路尚未验收**，详见文末「发布前必须完成」。

## 1. 目录结构

| 文件 | 作用 |
| --- | --- |
| `aegis.gd` | 运行时守卫（autoload `Aegis`）：启动校验、定时复查、失败拦截 |
| `aegis_license.gd` | 授权核心：设备 ID → 验中控证书 → 验子机授权 → 绑定/有效期/防回拨 |
| `aegis_rsa_verify.gd` | RS256 验签 + 信封/字段校验（由 `desktop/verifier-godot` 同步，勿手改） |
| `aegis_strict_json.gd` | 严格 JSON 解析（拒绝重复键、非法数字、非法 UTF-8 等，勿手改） |
| `aegis_device.gd` | 设备 ID：`DEV-` + `sha256(OS.get_unique_id())[0:16]`，不可用时回退 `user://aegis_device.id` |
| `aegis_vendor_key.gd` | **信任根**：厂商公钥（`n` 为空时一律拒绝） |
| `aegis_secret.gd` | 共享密钥，仅参与项目 ID 与时间记录校验 |
| `aegis_plugin.gd` / `aegis_dock.gd` | 编辑器插件与 Dock（显示项目 ID / 设备 ID / 密钥指纹 / 授权状态） |
| `aegis.cfg` | 编辑器内开关（导出后无效，始终强制校验） |
| `plugin.cfg` | 插件元数据 |

## 2. 安装

方式一（分发包）：

```bash
# 在 Godot 工程根目录执行，得到 addons/aegis/...
unzip addons.zip
```

方式二（源码）：把 `godot/addons/aegis/` 整个目录复制到目标工程的 `addons/aegis/`。

随后：

1. 打开 **项目设置 → 插件**，启用 **Aegis**；
2. 确认 **项目设置 → 全局 → Autoload** 中存在
   `Aegis="*res://addons/aegis/aegis.gd"`（启用插件时会自动添加，但导出前必须确认它真的写进了 `project.godot`，
   否则导出的程序不会校验）；
3. 在右侧 Dock 复制「项目 ID」与「设备 ID」，交给中控主机签发授权。

`.uid` 文件必须一起复制/解压，缺失会导致 Godot 重新分配资源 UID。

## 3. 授权文件放在哪里

插件只认两个固定文件名，内容都是协议信封 JSON（UTF-8、无 BOM、无结尾换行亦可）：

| 文件 | 内容 | 签发方 |
| --- | --- | --- |
| `control.cert` | `vendor-control` 信封（中控授权证书） | 厂商签发工具（厂商私钥） |
| `license.dat` | `machine-license` 信封（子机授权） | 客户中控（委托私钥） |

读取位置由 `aegis_license.gd::_base_dir()` 决定：

- **编辑器内 / 用编辑器二进制运行工程**：工程根目录（`res://`）；
- **导出后的程序**：可执行文件（exe）所在目录。

两个文件都缺失时先报 `0x013`（中控证书缺失），只有 `control.cert` 存在时才继续检查 `license.dat`。

## 4. 厂商公钥（信任根）

正式公钥只能写在 `aegis_vendor_key.gd`：

```gdscript
const VENDOR_PUBLIC_KEY := {
	"kty": "RSA",
	"n": "<base64url，256 字节模数，无填充>",
	"e": "AQAB"
}
```

要求：

- 只接受 modulus/exponent 形式，不解析 PEM/DER；
- 公钥是编译期常量，**不得**来自 `aegis.cfg`、授权文件、数据库或任何客户端可改的配置；
- `n` 为空 → `0x062`，所有授权一律拒绝（当前仓库就是这个状态）；
- 不得把测试公钥（`desktop/tests/fixtures/keys/*`）写进发布产物；
- 插件内不得出现厂商私钥或委托私钥；
- 分发包里的 `aegis_vendor_key.gd` 必须与源码一致（`python godot/package_addons.py` 会原样打包）。

## 5. 运行时行为

| 时机 | 行为 |
| --- | --- |
| autoload `_ready()` | 校验一次；失败立即拦截 |
| 运行中每 600 秒 | 复查 |
| 窗口重新获得焦点（含睡眠唤醒） | 复查 |
| 授权失效 | 暂停场景树 → 打印 `[Aegis] 授权校验失败 (Err: 0x0xx detail=...)` → GUI 弹窗 → 退出码 1 |
| headless / 无显示 | 不创建弹窗，直接退出码 1 |
| 弹窗未显示（环境异常） | 5 秒后强制退出码 1 |
| 弹窗显示但一直不关闭 | 30 秒后强制退出码 1（不依赖用户点「确定」才安全） |
| 重复触发失败 | 只处理一次，不会重复建弹窗或重复退出 |

受保护逻辑应这样门控：

```gdscript
func _ready() -> void:
	if not Aegis.is_licensed():
		return # 不要启动业务逻辑
	_start_game()
```

**已知限制（Godot 启动顺序）**：autoload 的 `_ready()` 一定早于主场景实例化，但 `quit()` 只在帧末生效，
因此主场景的 `_ready()` 仍会在同一帧内被调用一次；`_process` / `_physics_process` 从第一帧起就被
`paused` 拦住。所以：受保护逻辑不要直接写在主场景 `_ready()` 里，应放到 `_process` 或先用
`Aegis.is_licensed()` 判断。`PROCESS_MODE_ALWAYS` 的节点不受 `paused` 影响，不要用它承载受保护逻辑。

## 6. 错误码

| 错误码 | 含义 |
| --- | --- |
| `0x000` | 授权有效 |
| `0x011` / `0x012` | `license.dat` 缺失 / 为空 |
| `0x013` / `0x014` | `control.cert` 缺失 / 为空 |
| `0x021` | 中控证书验签失败（被改动 / 非本厂商签发 / 字段非法 / 时间值非法） |
| `0x022` | 子机授权验签失败（被改动 / 密钥不匹配 / 格式非法 / 时间值非法） |
| `0x023` | 中控证书已过期或尚未生效 |
| `0x033` | 项目 ID 不在授权范围或与授权不匹配 |
| `0x034` | 子机授权不属于当前中控证书 |
| `0x035` | 设备 ID 不匹配 |
| `0x036` | 授权状态不是 `active` |
| `0x037` | 子机授权有效期超出中控证书 |
| `0x041` | 到期时间早于签发时间 |
| `0x051` | 系统时间早于签发时间 |
| `0x052` | 系统时钟被回拨 |
| `0x061` | 无法确定设备 ID |
| `0x062` | 未配置厂商公钥 |
| `0x099` | 授权已到期 |

`0x0xx` 是插件侧的稳定分类码；协议层的具体原因放在日志与 Dock 的 `detail` 字段里
（如 `json_duplicate_key`、`signature_invalid`、`timestamp_invalid`）。

## 7. 测试

测试需要 Godot 4.6.3 console 版本：

```bash
export GODOT_BIN="E:/Program Files/Godot Engine/Godot_v4.6.3-stable_win64.exe/Godot_v4.6.3-stable_win64_console.exe"

cd desktop
npx vitest run tests/integration/godot-real-license.test.ts   # 授权链判定（25 项）
npx vitest run tests/integration/godot-deny-path.test.ts      # 失败拦截 / 时间戳 / 分发包 / 干净工程（11 项）

node scripts/godot-gui-popup-check.mjs                        # GUI 弹窗 + 确认后退出码 1
node scripts/godot-gui-deny-check.mjs                         # GUI 弹窗去重 + watchdog 兜底
node scripts/godot-gui-deny-check.mjs --hold                  # 弹窗显示期间不会被提前杀掉
```

GUI 脚本会短暂打开窗口；无显示环境请只跑 headless 部分（vitest 两套）。
`GODOT_BIN` 未设置时 vitest 整组跳过。

## 8. 重新生成 `addons.zip`

```bash
python godot/package_addons.py
```

- 产物：`godot/addons.zip`，压缩包根目录是 `addons/`，解压后直接得到 `addons/aegis/`；
- 内容：`addons/aegis/` 下全部 `.gd` / `.cfg` / `.uid`（当前 20 个文件 + 2 个目录条目）；
- 排除：`.import`、`.godot`、私钥、测试产物；
- 可重复：源文件不变时重复执行得到字节一致的结果。

**改了插件源码后必须重新打包**，否则分发包与源码不一致（`godot-deny-path.test.ts` 会检查这一点）。

## 9. 发布前必须完成

1. **配置生产厂商公钥**：把 `aegis_vendor_key.gd` 的 `n` 换成厂商真实公钥，并重新打包。
   当前为空 → 任何授权都会被 `0x062` 拒绝，生产链路不可用。
2. **生产授权链路验收**：用真实厂商密钥签发 `control.cert`，由客户中控签发 `license.dat`，
   在导出后的程序上跑通「有效 → 放行」「到期 / 篡改 → 拦截」。
3. **正式导出验收**：验证导出后 `_base_dir()` 取的是 exe 目录（本仓库测试都是用编辑器二进制运行的，
   走的是 `res://` 分支），并确认 `[autoload] Aegis` 存在于导出工程。
4. **确认分发包里没有测试密钥**：`python godot/package_addons.py` 后检查
   `addons/aegis/aegis_vendor_key.gd` 仍为空占位，再手工填入生产公钥并重新打包。

> 用测试公钥验签成功 **不等于** 生产授权验收完成。
