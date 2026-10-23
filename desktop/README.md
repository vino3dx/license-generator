# P1：Aegis 中控（desktop）

Vue 3 + TypeScript + Electron 的授权管理端：导入厂商 `control.cert` 与委托私钥，管理项目/设备，签发与续期子机授权，记录审计。

协议当前为 **v3**（`license.dat` 为内嵌 `control.cert` 的容器），见 [`../docs/license-protocol.md`](../docs/license-protocol.md)。

## 环境与启动

- Node.js ≥ 20（实测 24.x）+ npm
- 信任根：`AEGIS_VENDOR_PUBLIC_KEY`（JSON），或发布构建时替换 `src/main/vendor-trust.ts` 中的嵌入常量

```powershell
npm install
$env:AEGIS_VENDOR_PUBLIC_KEY = Get-Content ..\tools\master-issuer\out\vendor-root-public.json -Raw
npm run dev
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（electron-vite） |
| `npm run build` | 类型检查 + 生产构建（`out/`） |
| `npm run build:win` | 构建 + Electron Builder 打包（`release/`） |
| `npm run typecheck` | 主进程/核心 与 渲染进程分别检查 |
| `npm test` | Vitest 单元测试 |
| `npm run test:godot-integration` | 真实拉起 Godot headless 的集成测试（需 `GODOT_BIN`） |
| `npm run godot:vectors` / `godot:strict` | 跨语言协议向量 / 严格 JSON 向量（需 `GODOT_BIN`） |
| `npm run godot:sync` | 把 `tests/integration/verifier-godot/` 的验签核心同步进插件（生成物） |
| `npm run master:issue` | 调用 P0 根签发工具（源码在 `../tools/master-issuer/`） |
| `npm run smoke` | Electron 启动冒烟 |

## 结构

```
src/main/      主进程：窗口、IPC、授权运行时（数据库/文件仓库/委托私钥/信任根）
src/preload/   contextBridge 白名单
src/renderer/  Vue 3 界面：项目 / 设备 / 签发 / 授权管理 / 审计
src/core/license/   协议、信封、容器、RSA、签约与验签（纯 TS）
src/core/db/        SQLite（node:sqlite）连接、迁移、仓储
src/core/services/  项目/设备/签发/续期/审计业务与额度校验
src/shared/         跨进程 DTO、IPC 契约、协议常量
tests/              单元测试 + Godot 集成测试 + 测试密钥（TEST ONLY）
```

## 数据位置

- 数据库：`app.getPath('userData')/aegis.sqlite`（开发环境为 `%APPDATA%\aegis-desktop`）
- 授权文件：`userData/licenses/<licenseId>.json`（容器格式，可直接改名为 `license.dat` 交付）
- 委托私钥：`userData/keys/delegated.key.pem`

安装目录只放程序，不放业务数据；升级不会覆盖用户数据。

## 安全边界

- 渲染进程无 Node 权限、拿不到 `fs`/数据库/私钥；参数只有 ID 与文本，不接受路径。
- IPC handler 只做参数收敛与错误封包，全部业务校验在 `core/services`。
- 签发时重新验证中控证书签名与有效期；数据库里的 `status` 不能代替验签。
- 打包只含 `out/**` 与 `package.json`，不含 P0 工具、测试与任何私钥。

## 相关文档

- 协议：[`../docs/license-protocol.md`](../docs/license-protocol.md)
- 架构：[`../docs/architecture.md`](../docs/architecture.md)
- 密钥边界：[`../docs/key-management.md`](../docs/key-management.md)
- P0 工具：[`../tools/master-issuer/README.md`](../tools/master-issuer/README.md)
