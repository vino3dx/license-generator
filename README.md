# Aegis — 离线授权系统

Aegis 是一套「厂商签发 → 客户中控签发 → 子机本地校验」的离线授权系统，协议当前为 **v3**（`aegis-license/v3`）。
子机不联网也能校验；任何校验失败都会**静默退出**（无任何提示、退出码 1）。

## 1. 三层职责

| 层 | 职责 | 目录 | 技术栈 |
| --- | --- | --- | --- |
| **P0 厂商根签发** | 生成厂商根密钥、签发 `control.cert`、导出委托私钥、自检 | `tools/master-issuer/` | Node 24 + TypeScript（`.mts`） |
| **P1 中控** | 导入证书/委托私钥、项目与设备管理、单台与批量签发、续期、锁定/解绑、审计 | `desktop/` | Vue 3 + TypeScript + Electron + `node:sqlite` |
| **P2 子机插件** | 加载 `license.dat`、验签、设备/项目绑定、有效期与失败处理 | `godot/addons/aegis/` | GDScript（Godot 4.6.3） |

`godot/` 同时是插件的示例工程与集成验证载体（autoload `Aegis`）；`tests/` 放跨语言验证资产。

## 2. 目录结构

```
aegis/
├─ tools/master-issuer/         P0：master-issuer.mts（复用 desktop/src/core/license，不复制实现）
├─ desktop/                     P1：Electron 主进程 / preload / Vue 渲染进程 / core / tests
│  ├─ src/core/{license,db,services}   协议与密码学、SQLite、业务服务（纯 TS）
│  ├─ scripts/                  工具脚本（Godot 联调、打包检查、TS 别名加载器）
│  └─ tests/                    P1 单元测试 + Godot 集成测试
├─ godot/                       P2 示例工程 + addons/aegis 插件源码（唯一权威）
├─ tests/
│  ├─ vectors/                  跨语言测试向量（Node 与 Godot 共用）
│  └─ integration/verifier-godot/   独立 headless 验证工程（RSA/严格 JSON 的唯一源）
├─ docs/                        architecture / license-protocol / key-management
├─ releases/                    脚本生成的发布产物（不入库）
├─ python/                      旧版 Tkinter 生成器（历史，不参与当前流程）
└─ .workbuddy/memory/MEMORY.md  v3 协议定稿与项目既定结论（最高优先级）
```

## 3. 环境要求

- Node.js ≥ 20（本机实测 24.x）+ npm
- Godot **4.6.3** stable（跑集成测试与示例工程；脚本需 `GODOT_BIN` 指向 console 版可执行文件）
- Python 3（仅用于重新生成 `releases/aegis-addon-v3.zip`，可选）

## 4. 主要命令

```bash
# P0：签发中控证书（在 desktop/ 下执行；产物默认写 tools/master-issuer/out/）
cd desktop
npm run master:issue -- --license-id VND-2026-001 --project-ids proj-alpha --max-devices 50 --ttl-days 365

# P1：开发运行（信任根用 P0 生成的公钥注入）
$env:AEGIS_VENDOR_PUBLIC_KEY = Get-Content ..\tools\master-issuer\out\vendor-root-public.json -Raw
npm run dev

# P1：质量门禁
npm run typecheck
npm test
npm run build

# P1↔P2：Godot 集成测试（真实拉起 Godot headless）
$env:GODOT_BIN = 'E:\Program Files\Godot Engine\Godot_v4.6.3-stable_win64.exe\Godot_v4.6.3-stable_win64_console.exe'
npm run test:godot-integration

# 跨语言向量 / 严格 JSON 向量（同一份 tests/vectors）
npm run godot:vectors
npm run godot:strict

# 把验签核心同步进插件（生成物，勿手改插件里的副本）
npm run godot:sync

# P2：打包插件 ZIP（输出 releases/aegis-addon-v3.zip）
cd ..
python godot/package_addons.py
```

Window 下 P1 安装包：`cd desktop && npm run build:win`（产物在 `desktop/release/`）。

## 5. 子机侧安装（P2）

1. 解压 `releases/aegis-addon-v3.zip` 到目标 Godot 工程根（得到 `addons/aegis/`）；
2. 项目设置 → 插件 → 启用 Aegis；确认 Autoload 有 `Aegis="*res://addons/aegis/aegis.gd"`；
3. 从 Dock 读取「项目 ID / 设备 ID」，交给 P1 签发；
4. 把 P1 导出的 `license.dat` 放到工程根（编辑器）或 exe 同目录（导出后）。

插件内的 `aegis_vendor_key.gd` 是信任根，当前为空占位（为空即全部拒绝）。发布前必须填入正式厂商公钥；测试公钥不得写入插件源码或分发包。

## 6. 测试与发布

| 类型 | 命令 | 覆盖 |
| --- | --- | --- |
| P1 单元 | `cd desktop && npm test` | 协议/容器/服务/数据库/IPC 边界 |
| 跨语言认证 | `npm run godot:vectors` | 同一向量在 Node 与 GDScript 得到相同结论 |
| 严格 JSON | `npm run godot:strict` | 两端口径一致的解析拒绝规则 |
| 端到端 | `npm run test:godot-integration` | 真实 Godot：放行/篡改/过期/无授权静默退出、假中控拉取 |
| 导出验收 | `node desktop/scripts/godot-export-check.mjs` | Windows 导出后 fail-closed 与测试授权链（需 `GODOT_BIN`） |
| 打包 | `npm run build:win` / `python godot/package_addons.py` | P1 安装包 / P2 插件 ZIP |

## 7. 安全边界（摘要）

- 厂商根私钥只存在于 P0 签发环境与离线备份，**永不**入库、入包、入日志。
- 委托私钥由 P1 导入并保存在 `userData/keys/`，可被提取属已知限制。
- P1 打包只含 `out/**`，P0 工具、测试与密钥天然不进包。
- 详细材料清单与禁止事项见 [`docs/key-management.md`](docs/key-management.md)。

## 8. 文档

- 协议（当前 v3 + v1 历史附录）：[`docs/license-protocol.md`](docs/license-protocol.md)
- 架构与依赖方向：[`docs/architecture.md`](docs/architecture.md)
- 密钥与材料边界：[`docs/key-management.md`](docs/key-management.md)
- P1 工程说明：[`desktop/README.md`](desktop/README.md)
- P2 插件说明：[`godot/README.md`](godot/README.md)
- 旧部署设计稿（v1/v2 时期，含已被取代的描述）：[`docs/archive/license-architecture-v1v2.md`](docs/archive/license-architecture-v1v2.md)
