# Aegis Godot 插件（`addons/aegis`）

Aegis 中控授权体系在 Godot 客户端的执行组件：`license.dat` 是容器，内嵌中控证书与子机授权两个信封；
插件用编译期内置的厂商公钥验证证书，再用证书里的委托公钥验证子机授权。
**授权无效（缺失 / 过期 / 校验失败 / 设备或项目不匹配 / 旧格式）一律静默退出码 1**——
无弹窗、无界面、无任何输出，最终用户看不到任何授权失败提示。
授权有效时正常运行；临期由后台静默拉取续期，成功则无缝替换授权文件，不重启。

协议定义见 `docs/license-protocol.md`（当前 v3，RS256；文档末尾保留 v1 历史附录）。

> 当前状态：验签链路、失败拦截、分发包与干净工程安装、过期自动恢复（测试侧计时）、
> Windows 测试导出已验证；**厂商公钥仍为空占位，生产授权链路尚未验收**，详见文末「发布前必须完成」。

> **协议兼容性警告（2026-10-23）**：本插件的验签实现遵循冻结的 `aegis-license/v1`
> （`schema_version = 1`，payload 含 `features` 字段）。desktop 签发端当前是 schema v3
> （payload 内嵌 `control_cert`、无 `features`），两者不一致；**协议版本统一之前，
> 正式签发端与插件端不能宣称互通**。仓库内插件测试使用的授权向量是按协议文档
> 用测试私钥手工签名的，不是中控正式签发数据。也不要自行给插件加入 v1/v3
> 双版本兼容逻辑（协议要求未知版本一律拒绝）。

## 1. 目录结构

| 文件 | 作用 |
| --- | --- |
| `aegis.gd` | 运行时守卫（autoload `Aegis`）：启动校验、定时复查、临期静默续期、失败静默退出码 1 |
| `aegis_license.gd` | 授权核心：容器解析 → 六步校验链 → 防回拨 → 到期判断、原子替换授权文件 |
| `aegis_net.gd` | 局域网拉取：TCP 47821 优先、UDP 47820 发现兜底，纯轮询、总超时 2 秒 |
| `aegis_rsa_verify.gd` | RS256 验签 + 信封/字段校验（由 `tests/integration/verifier-godot` 经 `npm run godot:sync` 生成，勿手改） |
| `aegis_strict_json.gd` | 严格 JSON 解析（拒绝重复键、非法数字、非法 UTF-8 等，勿手改） |
| `aegis_device.gd` | 设备 ID：`DEV-` + `sha256(unique_id + "\|" + project_id)[0:16]`，不可用时回退 `user://aegis_device.id` |
| `aegis_vendor_key.gd` | **信任根**：厂商公钥（`n` 为空时一律拒绝） |
| `aegis_secret.gd` | 共享密钥，仅参与项目 ID 与时间记录校验 |
| `aegis_plugin.gd` / `aegis_dock.gd` | 编辑器插件与 Dock（显示项目 ID / 设备 ID / 密钥指纹 / 授权状态） |
| `aegis.cfg` | 编辑器内开关（导出后无效，始终强制校验） |
| `plugin.cfg` | 插件元数据 |

## 2. 安装

方式一（分发包）：

```bash
# 分发包由仓库根目录的 releases/ 提供（脚本生成，不在源码目录）
# 在目标 Godot 工程根目录执行，得到 addons/aegis/...
unzip /path/to/aegis/releases/aegis-addon-v3.zip
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

插件只读一个文件 `license.dat`，内容是**容器**（严格 JSON，UTF-8、无 BOM、无结尾换行）：

```json
{"v":1,"license":"<machine-license 信封文本>","control":"<vendor-control 信封文本>"}
```

| 字段 | 内容 | 签发方 |
| --- | --- | --- |
| `license` | `machine-license` 信封（子机授权） | 客户中控（委托私钥） |
| `control` | `vendor-control` 信封（中控授权证书） | 厂商签发工具（厂商私钥） |

约束：键集合必须恰好是 `v` / `license` / `control`，`v` 必须为 `1`，整体不超过 16384 字节。
旧版「裸信封 + 单独 `control.cert`」布局不再兼容，返回 `0x016`（不崩溃）。

读取位置由 `aegis_license.gd::_base_dir()` 决定：

- **编辑器内 / 用编辑器二进制运行工程**：工程根目录（`res://`）；
- **导出后的程序**：可执行文件（exe）所在目录。

该目录必须可写：界面导入授权与局域网拉取都要「写临时文件 + rename」替换 `license.dat`。

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
| autoload `_ready()` | 校验一次 |
| 运行中每 600 秒 / 窗口重新获得焦点（含睡眠唤醒） | 复查 |
| 授权有效且距到期 ≥ 30 天 | **完全不访问网络**（网络只能延长授权，不能维持授权） |
| 授权有效且距到期 < 30 天 | 启动时与每 6 小时后台拉取一次（`aegis_net.gd`，失败静默） |
| 校验失败（headless / 有显示一视同仁） | 暂停场景树 → **静默退出码 1**：无弹窗、无界面、无打印、无日志 |
| 重复触发失败 | 只处理一次，不会重复退出 |

主场景会被暂停（`get_tree().paused = true`），不会清空 `main_scene`。
**注意：插件失败时没有任何输出，退出码 1 是唯一的失败信号**——错误码细节只在编辑器 Dock
的「检查当前授权状态」里可见（开发期诊断用），导出后的程序不提供任何提示。

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

### 5.1 局域网拉取（`aegis_net.gd`）

| 阶段 | 协议 |
| --- | --- |
| 直连 | 先试缓存的 `host:port`，再试 `127.0.0.1:47821` |
| 发现 | 前者都失败时广播 UDP `47820`：`AEGIS-DISCOVER/1 <device_id> <project_id>`，中控单播回 `AEGIS-HERE/1 <host> <tcp_port>` |
| 拉取 | TCP 一问一答，子机发一行 JSON（`v/device_id/project_id/current_license_id/last_expires_at/nonce`，≤4096 字节），中控回 `v/status/license/reason/nonce` 后关闭 |

- 全部等待都在 `_process` 里轮询，不阻塞主线程；**一次拉取的总超时是 2 秒**（覆盖发现 + 连接 + 收发）；
- 子机必须核对 `nonce` 回显；`issued` 的授权要走完整的六步校验，且 `expires_at` **严格晚于**本地授权才接受；
- 接受后原子替换 `license.dat`（临期续期场景，不重启）；`unchanged` / `denied` / 校验失败 / 超时一律静默，不改本地状态。

### 5.2 静默拦截与临期续期（2026-10-23 行为变更）

> 2026-10-23 用户决定：**移除申请码门控界面、导入授权入口与全部输出，授权无效一律静默闪退**。
> 本节取代 v3.1 规格中「GUI 失败 → 申请码界面 + 过期每 5 分钟自动恢复」的方案；
> `.workbuddy` 规格文件按约定未改动，以本节与代码为准。

| 阶段 | 实际行为 |
| --- | --- |
| 校验失败（任何原因） | `paused = true` + `quit(1)`：主场景 `_process` 被拦住，进程静默退出 |
| 授权过期 | 与其它失败相同：**立即退出，不再有 5 分钟自动恢复**。进程退出后中控上线也无法救回，续期只能靠把新 `license.dat` 手工放到 exe 同目录后重新启动 |
| 授权有效但临期（< 30 天） | 后台每 6 小时静默拉取；拿到**严格更新**的授权就无缝替换 `license.dat`，不重启、无提示 |
| 拉取失败 / `unchanged` / `denied` / 响应非法 | 完全静默，本地状态不变，授权仍有效则继续运行 |

导入授权文件入口已随界面一并移除：给客户换授权 = 把新的 `license.dat` 拷贝到
**exe 同目录**（编辑器内为工程根目录），覆盖后重启程序。

## 6. 错误码

| 错误码 | 含义 |
| --- | --- |
| `0x000` | 授权有效 |
| `0x011` / `0x012` | `license.dat` 缺失 / 为空 |
| `0x015` | 授权容器不合法（键集合、版本、字段类型、大小 > 16384 字节、非法 JSON） |
| `0x016` | 旧版授权格式（裸信封或单独的 `control.cert`）：请向中控重新获取 `license.dat` |
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
npx vitest run tests/integration    # 四个文件：授权链 / 失败拦截与分发包 / 局域网拉取 / 过期恢复

node scripts/godot-gui-deny-check.mjs   # GUI 静默拦截：退出码 1、无任何输出、有效授权持续运行
node scripts/godot-export-check.mjs     # Windows 导出：构建成功、静默拦截、测试授权链
```

| 测试文件 | 覆盖 |
| --- | --- |
| `godot-real-license.test.ts` | 容器严格解析、六步校验链各出口、设备 ID 加盐与回退、防回拨、续期窗口 |
| `godot-deny-path.test.ts` | headless 静默拦截与退出码、时间戳严格性、`addons.zip` 一致性、干净工程安装 |
| `godot-net.test.ts` | TCP 47821 / UDP 47820、状态码处理、nonce 校验、防降级、2 秒总超时 |
| `godot-silent-exit.test.ts` | GUI 模式静默退出：无授权 / 过期 → 退出码 1 且无输出；有效授权 → 持续运行不被拦截 |

网络测试用进程内的假中控（不依赖真实中控），并且必须用异步子进程启动 Godot：
`spawnSync` 会阻塞 Node 事件循环，假中控就收不到连接。
联调用例占用固定端口（TCP 47821 / UDP 47820），vitest 配置了 `fileParallelism: false` 串行执行。

GUI / 导出脚本会短暂打开窗口；无显示环境请只跑 headless 部分（vitest 四套）。
`GODOT_BIN` 未设置时 vitest 整组跳过。

导出检查只覆盖「构建成功 / 失败拦截 / 测试授权链」三件事，
**生产协议互通**（中控统一 `schema_version` 后用正式签发数据端到端验证）不在其中，不能互相替代。

### 7.1 Windows 导出检查（`scripts/godot-export-check.mjs`）

前置条件：

- `GODOT_BIN` 指向 Godot **4.6.3** console 版本（与工程 `config/features` 匹配）；
- 已安装导出模板 `%APPDATA%/Godot/export_templates/4.6.3.stable`（Windows x86_64 release）；
- `godot/export_presets.cfg` 存在 "Windows Desktop" 预设（`export_path` 为空即可，
  脚本用命令行显式给出输出路径，不改预设文件）。

```bash
cd desktop
node scripts/godot-export-check.mjs          # 全部检查
AEGIS_KEEP_EXPORT=1 node scripts/godot-export-check.mjs   # 保留产物目录便于人工复验
```

脚本做两次**隔离**导出（产物在系统临时目录，不进仓库）：

| 步骤 | 用哪个工程 | 验证什么 |
| --- | --- | --- |
| 1. 原始工程导出 | `godot/` 原样（空厂商公钥、无授权文件） | Release 导出可构建；导出后 `_base_dir()` 取 exe 目录；无授权 + 空公钥 → `0x062`、退出码 1、不挂起（fail-closed） |
| 2. 测试公钥副本导出 | 复制到临时目录、**只**把 `aegis_vendor_key.gd` 换成 `desktop/tests/fixtures/keys/` 的测试公钥 | 用编辑器二进制跑探针读取项目/设备 ID → 测试私钥签 90 天容器写到 exe 同目录 → 导出程序放行并持续运行 |

结果解读：

- `RESULT` JSON 任何一项为 `false` 时脚本退出码为 1；
- 测试授权放行的运行用例会在 8 秒后被脚本**超时终止**（`status: null`）——这是预期行为：
  「进程一直活着」正是「授权有效、未退出」的证据，不是失败；
- 原始工程的导出不含 `license.dat`（非资源文件不会打进包），所以无授权拦截检查的是真实发布形态。

边界（必须区分的四个概念）：

1. **导出构建成功** = 引擎能产出可运行的 exe/pck；
2. **无授权时拒绝运行** = fail-closed 生效；
3. **测试授权链通过** = 用测试密钥手工签的容器能在导出程序里走完六步校验；
4. **正式中控签发数据与插件端到端互通** = **未完成**，依赖协议版本统一（见文首警告）。

前三项不能代替第四项。测试密钥只存在于 `desktop/tests/fixtures/keys/`（文件名标注 TEST ONLY），
只用于隔离的临时副本，**不得**写进生产插件源码、`addons.zip` 分发包或生产授权文件；
打包测试会检查 `addons.zip` 里的 `aegis_vendor_key.gd` 仍是空占位。

## 8. 重新生成插件分发包

```bash
python godot/package_addons.py          # 输出 ../releases/aegis-addon-v3.zip
python godot/package_addons.py out.zip  # 也可指定输出路径
```

- 产物：`releases/aegis-addon-v3.zip`（不再写回源码目录），压缩包根目录是 `addons/`，解压后直接得到 `addons/aegis/`；
- 内容：`addons/aegis/` 下全部 `.gd` / `.cfg` / `.uid`（当前 22 个文件 + 2 个目录条目）；
- 排除：`.import`、`.godot`、私钥、测试产物；
- 可重复：源文件不变时重复执行得到字节一致的结果。

**改了插件源码后必须重新打包**，否则分发包与源码不一致（`godot-deny-path.test.ts` 会检查这一点）。

## 9. 发布前必须完成

1. **配置生产厂商公钥**：把 `aegis_vendor_key.gd` 的 `n` 换成厂商真实公钥，并重新打包。
   当前为空 → 任何授权都会被 `0x062` 拒绝，生产链路不可用。
2. **生产授权链路验收**：用真实厂商密钥签发 `control.cert`，由客户中控签发 `license.dat`，
   在导出后的程序上跑通「有效 → 放行」「到期 / 篡改 → 拦截」。
3. **正式导出验收**：`node scripts/godot-export-check.mjs` 已验证 Release 导出可构建、
   导出后 `_base_dir()` 取 exe 目录（空公钥 → 静默退出码 1；放测试授权 → 放行且持续运行）。
   剩余：用**生产厂商公钥**重打包后重复该检查，并用正式签发数据端到端验证。
4. **确认分发包里没有测试密钥**：`python godot/package_addons.py` 后检查
   `addons/aegis/aegis_vendor_key.gd` 仍为空占位，再手工填入生产公钥并重新打包。

> 用测试公钥验签成功 **不等于** 生产授权验收完成。
