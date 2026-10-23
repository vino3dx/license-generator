# Aegis 密钥与授权材料管理

> 只记录规则与边界，**不含任何真实密钥值**。
> 「同一仓库里的目录分离」不等于物理隔离：P0 根签发应在受控环境执行，正式 P1 安装包不得包含 P0 工具或根私钥。

## 1. 材料清单

| 材料 | 生成方 | 存放位置 | 可否分发 | 可否入库 |
| --- | --- | --- | --- | --- |
| 厂商根私钥 `vendor-root-private.pem` | P0（`master:issue`，一次性生成） | P0 签发机器离线保存 | **否** | **否** |
| 厂商根公钥 `vendor-root-public.json` | P0 | 随构建注入 P1/P2 | 是（公开材料） | 视需要（当前未入库） |
| 委托私钥 `delegated-private.pem` | P0 | P1 导入后存 `userData/keys/` | 仅交付给客户中控 | **否** |
| `control.cert` | P0 | P1 导入 → SQLite | 是（可公开验证） | 否（生产证书） |
| `license.dat`（容器） | P1 | 子机工程根 / exe 同目录 | 是 | 否（生产授权） |
| 测试私钥（vendor/delegate/rogue） | 测试生成 | `desktop/tests/fixtures/keys/` | 否 | **是**，文件头标注 `TEST ONLY` |
| 测试向量 `tests/vectors/*.json` | 由测试代码生成 | `tests/vectors/` | 否（含测试签名） | 是 |
| 示例工程 `godot/license.dat` | 测试签发 | `godot/` | 否 | 当前已跟踪，属示例样本，不得当生产授权 |

## 2. 硬性规则

1. 厂商根私钥**永不**进入：P1 安装包、P2 插件、Git、日志、数据库、配置模板。
2. 委托私钥不进数据库、不进日志、不进构建产物；只在 `userData/keys/delegated.key.pem`（0600）或受控存储中。
3. 发布前检查：
   - `electron-builder.yml` 的 `files` 只含 `out/**` 与 `package.json`；
   - `releases/aegis-addon-v3.zip` 内只有 `addons/aegis/**`；
   - 仓库 `git status` 不含 `master-issuer-out/`、`releases/`、任何 `.pem`（测试密钥除外）。
4. 测试材料只能放在 `desktop/tests/fixtures/`（当前实现），不得写入 `godot/addons/aegis/`、插件 ZIP 或生产授权文件。
5. 不得为了排障而打印私钥、完整密钥文件或生产授权内容。
6. 一旦发现疑似生产私钥入库：停止发布、报告，不自行上传/公开/继续复制。

## 3. 与发布流程的对应关系

- P0 产物默认写到 `tools/master-issuer/out/`，已被 `.gitignore` 忽略。
- P1 打包只取 `out/**`，`tools/`、`tests/` 天然不进包。
- P2 打包脚本 `godot/package_addons.py` 只遍历 `godot/addons/`，不读取任何密钥目录。

## 4. 已知限制（不是"已具备的技术保障"）

- 委托私钥保存在客户中控本机文件里，普通 Windows 环境无法保证不可提取；P1 可被提取即等于获得签发能力。
- 插件内厂商公钥是公开信任材料，被替换即可绕过验签；因此发布前必须填入正式公钥并防止二次修改（构建签名/校验留待发布流程完善）。
- 子机离线时无法立即撤销；`status` 是签发时刻快照。
- 本地时间回拨无法通过纯离线手段完全防御，当前只有基础回拨检查。
