# Aegis 授权管理中控（desktop）

Vue 3 + TypeScript + Electron 的授权管理桌面程序。独立工程，不依赖旧的 Python 生成器，也不兼容旧版授权格式。

## 环境要求

- Node.js >= 20（开发机实测 24.16.0）
- npm >= 10（本工程使用 npm，不使用 pnpm/yarn 锁文件）
- Windows 10/11 x64（目标平台；打包产物不要求最终用户安装 Node.js/Python）

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖 |
| `npm run dev` | 启动开发模式（Vite + Electron 热更新） |
| `npm run typecheck` | 主进程/preload/核心 与 渲染进程分别做类型检查 |
| `npm run build` | 类型检查 + 生产构建（输出到 `out/`） |
| `npm run build:win` | 生产构建 + Electron Builder 打包（输出到 `release/`） |
| `npm test` | Vitest 单元测试（含授权协议与测试向量） |
| `npm run godot:vectors` | 在 Godot headless 下用同一份测试向量交叉验证 GDScript 验签器（需 `GODOT_BIN`） |
| `npm run godot:release` | 导出 Release 模板后再跑一次，用于测量 Release 耗时（需 `GODOT_BIN`） |
| `npm run godot:strict` | 在 Godot headless 下运行严格 JSON 共享向量（需 `GODOT_BIN`） |
| `npm run godot:sync` | 把 `verifier-godot/` 的验签核心与严格解析器同步进 `godot/addons/aegis/`（生成物，勿手改） |
| `node scripts/godot-gui-popup-check.mjs` | 非 headless 下检查失败提示框与关闭后退出（会短暂开窗，需 `GODOT_BIN`） |
| `npm run smoke` | 启动真实 Electron 客户端，用临时 userData 验证 IPC 链路、项目创建、重复拒绝与审计落库 |
| `npm run strict:cases` | 重新生成 `tests/fixtures/strict-json-cases.json` |
| `AEGIS_WRITE_VECTORS=1 npm test` | 重新生成 `tests/fixtures/vectors.json` |

## 目录结构

```
desktop/
├─ src/main/          Electron 主进程：窗口、生命周期、IPC handler
│  └─ ipc/            通道注册（按业务拆分，集中挂载）
├─ src/preload/       安全桥：只通过 contextBridge 暴露白名单方法
├─ src/renderer/      Vue 3 界面（页面、组件、样式）
├─ src/core/          授权业务核心（不依赖 electron / DOM）
│  ├─ license/        证书结构、签发与验签（阶段 2）
│  ├─ db/             SQLite 迁移与仓储（阶段 3）
│  └─ services/       项目/设备/签发/审计业务（阶段 3）
├─ src/shared/        跨进程共享类型、IPC 契约、协议常量
├─ tests/             单元测试、测试向量、测试密钥（TEST ONLY）
├─ verifier-godot/    纯 GDScript 验签器 + 独立 headless 验证工程（不参与桌面打包）
├─ docs/              协议文档
├─ scripts/           辅助脚本（Godot 交叉验证）
└─ electron-builder.yml
```

## 架构边界

- 渲染进程不直接访问数据库、文件系统或私钥；一切经 preload 暴露的最小 API → 主进程业务层。
- `src/core` 是可抽出的纯业务层，未来可整体并入聚合项目，界面壳可替换。
- 窗口安全基线：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，禁止应用内导航和新窗口，外链交给系统浏览器。
- 可写数据（数据库、日志、配置）落在 `app.getPath('userData')`，不写安装目录。
- 厂商私钥不进入本工程产物；客户中控只持有厂商授权证书与自己的委托签发密钥。
- 厂商公钥是编译期信任根，不来自数据库、配置文件或授权文件本身，共两处：
  - 中控侧：`src/main/vendor-trust.ts` 的 `EMBEDDED_VENDOR_PUBLIC_KEY`（当前为 `null`，开发环境可用 `AEGIS_VENDOR_PUBLIC_KEY` 注入测试公钥）；
  - 子机侧：`godot/addons/aegis/aegis_vendor_key.gd` 的 `VENDOR_PUBLIC_KEY`（当前 `n` 为空）。
  两处留空时都 fail-closed（拒绝所有授权）。**当前两处均未配置生产公钥，不能签发可供客户使用的授权。**
- 委托私钥存在 `userData/keys/`，不进数据库、日志或构建产物；Windows 下仍可能被提取（已知限制），后续可替换为 `safeStorage` 等受控存储。

## 当前阶段

阶段 1（工程骨架）已完成。
阶段 2（授权协议与验签核心）已完成：RS256 信封协议、厂商证书与子机授权两层签发/验签、严格 JSON 与 Base64URL 校验、固定测试向量、Node 与 GDScript 交叉验证。
阶段 3（SQLite 数据层与业务服务）已完成：版本化迁移、项目/设备/授权/证书/审计/设置六类表、签发与批量签发、续期、锁定解绑、额度校验、授权文件原子写入与中断恢复、受控 IPC。界面仍未接入真实业务，局域网功能在阶段 6。
阶段 4（Godot 插件接入与真实授权联调）已完成：插件改为 `aegis-license/v1` 双文件校验（`control.cert` + `license.dat`）、设备 ID 派生、严格 JSON 解析器、Node→Godot 真实授权联调 25 项。
阶段 5（中控业务界面）已完成：四个页面接入真实业务服务，新增项目编辑、委托私钥导入、证书文件选择与端到端冒烟。

授权协议细节见 [`docs/license-protocol.md`](docs/license-protocol.md)。

## 数据层与业务服务

### 表结构（迁移 v1）

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `schema_migrations` | 迁移版本记录 | `version` 主键，只追加 |
| `projects` | 项目 | `project_id` 主键，`status ∈ {active, archived}` |
| `devices` | 登记设备 | `(project_id, device_id)` 主键；部分唯一索引保证同一设备同时只能有一条未解绑记录 |
| `control_certificates` | 已导入的厂商中控证书 | `license_id` 主键；部分唯一索引保证最多一张 `is_active=1` |
| `licenses` | 子机授权记录 | 外键指向设备与中控证书；`status ∈ {active, revoked}` 与协议一致；`file_state ∈ {pending, written}` |
| `audit_logs` | 审计日志 | 只追加；记录 action/target/result/error_code/脱敏 context |
| `app_settings` | 非敏感设置 | 键值表，不存私钥或授权文件内容 |

数据库只存授权文件的相对文件名与 payload 的 SHA-256，不存私钥、不存授权文件全文。

### 设备额度

协议里 `max_devices` 是**中控证书级别的全局额度**（`vendor-control` payload 的单一字段，不按项目分别限制），因此实现为：

```
已用额度 = COUNT(设备 WHERE unbind_at IS NULL AND project_id ∈ 证书项目范围)
```

- 证书 `project_ids` 为 `["*"]` 时统计全部项目；否则只统计范围内的项目。
- 锁定设备不解绑，仍然占额度；续期不改变已用额度；解绑释放额度。
- 重复登记同一台已登记设备是幂等操作，不重复占用额度。
- 登记前与签发前都会校验；若导入了一张更小额度的证书导致已用额度超限，签发会被拒绝。

### 授权文件一致性策略

1. 先在内存里完成全部校验与签名（失败则什么都不写）。
2. `BEGIN IMMEDIATE` 事务内重新校验额度/设备并插入 `file_state='pending'` 记录后提交（预留）。
3. 逐个写文件：同目录临时文件 → `fsync` → `rename` 原子替换。
4. 第二个事务把记录改为 `written`、把同设备的旧授权标记 `superseded_by`、写成功审计。
5. 任一步失败按相反顺序补偿：删已写文件 → 删预留记录 → 写失败审计；补偿失败也不会伪装成功。
6. 启动时 `maintenance.reconcile()`：`pending` 记录连同残留文件回滚，目录中没有数据库记录的孤儿文件移入 `orphan/` 并记审计。

批量签发采用**全批成功**策略：任一设备不满足条件则整批不落库、不落文件，返回失败原因。

### 服务 API

`createLicenseServices(deps)` 返回业务门面：`projects` / `devices` / `control` / `licensing` / `audit` / `delegatedKeys` / `maintenance`。
渲染进程只能通过 `window.aegis.license.*`（21 个 `license:*` 通道）访问，参数只有 ID 与文本，不接受路径。

## Godot 插件接入（阶段 4）

`godot/addons/aegis/` 已从旧版 AES 共享密钥方案切换到 `aegis-license/v1`：

| 文件 | 作用 |
| --- | --- |
| `aegis_license.gd` | 授权核心：双文件校验、项目/设备/状态/时间绑定、防回拨 |
| `aegis_device.gd` | 设备 ID：`DEV-` + `sha256(OS.get_unique_id())[0:16]`；不可用时回退 `user://aegis_device.id`，仍失败则拒绝授权 |
| `aegis_vendor_key.gd` | 编译期厂商公钥（信任根）；`n` 留空时拒绝所有授权 |
| `aegis_rsa_verify.gd`、`aegis_strict_json.gd` | 由 `npm run godot:sync` 从 `verifier-godot/` 生成，禁止手改 |
| `aegis.gd` | 运行时守卫：启动、每 10 分钟、焦点恢复时校验；失败显示错误码并 `quit(1)` |
| `aegis_dock.gd` | 编辑器 Dock：显示项目 ID、设备 ID、密钥指纹与当前授权状态 |

授权文件位置沿用旧规则：编辑器为工程根目录，导出后为 exe 同目录。

- `control.cert`：厂商签发的中控证书（`vendor-control`）
- `license.dat`：中控签发的子机授权（`machine-license`）

旧版 AES `license.dat` 不会被新验证器接受，也不做自动迁移。中控签发时必须使用 Dock 显示的项目 ID 与设备 ID。

### 分发包

`godot/addons.zip` 由仓库根的 `python godot/package_addons.py` 生成，条目结构与源码一致（`addons/aegis/...`），包含 `.gd`、`.cfg`、`.uid`，不包含 `.godot` 缓存与 `.import`。修改插件后必须重新生成，否则分发包仍是旧版。

### 交付阻塞项

- 厂商公钥未配置（见「架构边界」两处），当前只能用测试密钥做联调，不能签发可供客户使用的授权。
- 委托私钥未随程序分发：需要在「授权签发」页导入与中控证书匹配的 RSA 2048 私钥，否则签发会被业务层拒绝（`delegated_key_missing`）。
- 旧版 AES `license.dat` 不被接受，客户需要重新签发 `control.cert` + `license.dat`。

## 业务界面（阶段 5）

四个页面全部接入真实业务服务，不再有占位实现：

| 页面 | 功能 |
| --- | --- |
| 项目管理 | 项目列表（ID / 名称 / 状态 / 中控范围 / 创建时间）、新建、编辑名称、查看详情；重复 ID 与格式在前端提示，最终由服务层校验 |
| 设备管理 | 按项目筛选、登记设备、锁定 / 解锁、解绑（必填原因）、查看单台设备的授权文件实校验结果；显示额度已用 / 上限 |
| 授权签发 | 展示厂商公钥、中控证书、额度、委托私钥四类状态；导入中控证书（粘贴或选文件）、导入委托私钥；单台签发、批量签发、续期；结果显示子机 `license.dat` 的完整路径 |
| 签发记录 | 审计列表与筛选（操作类型 / 对象 ID / 条数），详情展示脱敏上下文；记录只来自业务层 |

界面边界：

- 渲染进程只通过 preload 暴露的 21 个方法访问业务层，拿不到 `ipcRenderer`、`fs`、SQLite 或私钥。
- 中控证书文件选择由主进程弹系统对话框并读取文本（`src/main/control-file.ts`），渲染进程拿不到任意路径读取能力。
- 委托私钥通过 IPC 传入后写入 `userData/keys/delegated.key.pem`（0600），只返回配置状态，不回传私钥内容，审计不记录私钥。
- 界面禁用只是提示，额度、项目范围、有效期、证书链校验全部在服务层重复执行。

## 后续阶段

1. 阶段 6：Windows 打包与交付验证
2. 阶段 7：局域网设备控制

## 授权协议速览

- 签名算法：RSASSA-PKCS1-v1_5 + SHA-256（RS256），RSA-2048。
- 信封：`{aegis, schema_version, license_type, alg, kid, payload, signature}`，`payload` 与 `signature` 均为无填充 Base64URL。
- 被签名对象就是 payload 的原始字节，验签通过后才解析 JSON。
- 公钥只用 `{kty, n, e}`（modulus / exponent），Godot 侧不解析 PEM/DER。
- 两层链：厂商私钥签中控证书（内含委托公钥）→ 委托私钥签子机授权 → 子机用厂商公钥验证书、用证书内委托公钥验授权。

Godot 侧验签耗时实测（20 次平均）：

| 环境 | 首次（含公钥预计算） | 稳态单次 |
| --- | --- | --- |
| 4.6.3 headless（编辑器二进制） | 111 ~ 121 ms | 60 ~ 63 ms |
| 4.6.3 Release 导出 | 84 ~ 91 ms | 46 ~ 50 ms |

（同一台机器、同一份向量；首次包含 R² mod n 的 4096 次模加倍预计算，之后按公钥缓存。）
