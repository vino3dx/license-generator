# Aegis 架构（当前实现）

> 描述**现状**，不是规划。协议细节见 [`license-protocol.md`](license-protocol.md)；
> 密钥与材料边界见 [`key-management.md`](key-management.md)。
> 旧版部署设计稿保留在 [`archive/license-architecture-v1v2.md`](archive/license-architecture-v1v2.md)（含已被 v3 取代的描述，勿据此实现）。

## 1. 三层职责

| 层 | 职责 | 位置 | 技术栈 |
| --- | --- | --- | --- |
| **P0 厂商根签发** | 生成厂商根密钥、签发 `control.cert`、导出委托私钥；验证签名与过期拒绝 | `tools/master-issuer/` | Node 24 + TypeScript（`.mts`，Node 原生类型剥离） |
| **P1 中控** | 项目/设备管理、单台与批量签发、续期、锁定/解绑、审计；导入中控证书与委托私钥 | `desktop/` | Vue 3 + TypeScript + Electron + SQLite（`node:sqlite`） |
| **P2 子机插件** | 本地加载 `license.dat`、验签、设备绑定、有效期与失败处理 | `godot/addons/aegis/` | GDScript（Godot 4.6.3） |

另外两处不属于运行时：

- `godot/` 本身是**示例/自测工程**（`project.godot` + `main.tscn` + autoload `Aegis`），也是插件的集成验证载体；
- `tests/` 是跨语言验证资产（向量、夹具、独立 headless 工程）。

## 2. 依赖方向

```
tools/master-issuer  ──┐
                       ├─→ desktop/src/core/license/（协议与密码学唯一实现，纯 TS）
desktop/src/main     ──┘        ↑
desktop/src/renderer ──IPC──→ desktop/src/main ─→ core/db + core/services

godot/addons/aegis/aegis_{rsa_verify,strict_json}.gd
        ↑ 由 desktop/scripts/sync-godot-addon.mjs 从 tests/integration/verifier-godot/ 生成
```

- P0 与 P1 **复用同一份** `core/license`，不复制协议实现；P0 依赖的是源码，不是 npm 包。
- `core/license` 只依赖 `node:crypto` 与自有工具，不依赖 Electron / DOM。
- P2 与 TS 端无代码共享，靠**跨语言测试向量**（`tests/vectors/`）保持行为一致。

## 3. 授权文件流转

```
tools/master-issuer（厂商根私钥）
  ├─ control.cert                  → 交给 P1 导入
  ├─ delegated-private.pem         → 交给 P1 导入（中控签发能力）
  └─ vendor-root-public.json       → 作为 P1/P2 的编译期信任根注入

P1 中控（委托私钥）
  └─ userData/licenses/<licenseId>.json（容器：license 信封 + 内嵌 control 信封）
        └─ 人工拷贝为子机工程根 / exe 同目录的 license.dat

P2 插件
  └─ 读取 license.dat → 容器解析 → 厂商公钥验 cert → 委托公钥验 license
       → device_id / project_id / 有效期 → 失败静默 quit(1)
```

局域网拉取（UDP 47820 发现 + TCP 47821 拉取）P2 客户端已实现，P1 侧服务端尚未实现，故当前只有人工交付路径。

## 4. 运行时边界

- 渲染进程：`contextIsolation` 开、`nodeIntegration` 关、沙箱开；只能调用 preload 白名单方法，参数只有 ID/文本，不接受路径。
- 主进程：唯一持有数据库连接、授权文件目录、委托私钥；IPC handler 只做参数收敛与错误封包。
- 业务层（`core/services`）：所有权限、额度、有效期、状态校验都在这里，绕开界面不能绕开校验。
- 子机：无 UI 提示、无弹窗；任何校验失败静默 `quit(1)`。编辑器内可用 Dock 诊断（不影响导出行为）。

## 5. 构建与发布边界

| 产物 | 生成方式 | 内容约束 |
| --- | --- | --- |
| P1 安装包 | `cd desktop && npm run build:win` | `electron-builder.yml` 只打包 `out/**` + `package.json`；不含 `tools/`、`tests/`、任何私钥 |
| P2 插件 ZIP | `python godot/package_addons.py` | 输出到 `releases/aegis-addon-v3.zip`；只含 `addons/aegis/**`（.gd/.cfg/.uid/.tscn），不含密钥与测试工程 |
| P0 产物 | `cd desktop && npm run master:issue` | 默认写 `tools/master-issuer/out/`，已被 `.gitignore` 忽略，禁止入库 |

`releases/` 全部由脚本生成，禁止手工修改已发布 ZIP。

## 6. 测试边界

| 范围 | 位置 | 说明 |
| --- | --- | --- |
| P1 单元测试 | `desktop/tests/**` | 协议、容器、服务、数据库、渲染、IPC 边界 |
| 跨语言协议向量 | `tests/vectors/` | Node 与 Godot 读同一份，断言相同的接受/拒绝结论 |
| P2 headless 验证工程 | `tests/integration/verifier-godot/` | RSA 与严格 JSON 的**唯一可维护源**；`godot:sync` 把生成物写进插件 |
| P2 集成测试 | `desktop/tests/integration/` | 真实拉起 Godot：真实授权放行、篡改/过期/无授权静默退出、假中控网络 |

## 7. 与设计稿的已知差异

- `docs/archive/license-architecture-v1v2.md` 描述的「试用标记 `features`」「单独分发 `control.cert`」「到期显示申请码/暂停不退出」均**不是**当前实现：
  v3 已删除 `features`、改为内嵌 cert，失败策略为静默退出。
- `.workbuddy/memory/MEMORY.md` 记录的 v3 约定仍是最高依据；若与其冲突，以该记录为准。
