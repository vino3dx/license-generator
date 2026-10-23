# P0：Master Issuer（厂商根签发工具）

独立于客户侧安装包运行。职责：生成/复用厂商根私钥 → 生成委托密钥对 → 签发 v3 `control.cert` → 导出委托私钥 → 自检。

## 运行

```bash
cd ../../desktop          # 复用 desktop/scripts/lib 的 TS 别名加载器
npm run master:issue -- --license-id VND-2026-001 --project-ids proj-alpha --max-devices 50 --ttl-days 365
```

| 参数 | 说明 |
| --- | --- |
| `--license-id` | 证书 ID（标识符，1..128） |
| `--project-ids` | 逗号分隔，`*` 表示不限项目 |
| `--max-devices` | 证书级全局设备额度 |
| `--ttl-days` / `--expires-at` | 二选一；证书有效期上限 |
| `--vendor-key` | 复用已有厂商根私钥（不生成新根） |
| `--out-dir` | 输出目录，默认本目录下 `out/` |

## 产物（`out/`，已被 .gitignore 忽略）

| 文件 | 用途 | 敏感性 |
| --- | --- | --- |
| `control.cert` | 交给 P1 导入 | 可分发（可公开验证） |
| `delegated-private.pem` | 交给 P1 导入，用于签发子机授权 | **私钥** |
| `delegated-public.json` | 与证书内委托公钥比对 | 公开 |
| `vendor-root-public.json` | P1/P2 编译期信任根 | 公开 |
| `vendor-root-private.pem` | 仅首次生成时写出 | **根私钥，离线保存** |

## 边界

- 复用 `desktop/src/core/license` 的协议实现（源码复用，不复制、不打包成独立 npm 包）。
- 本工具不进入 P1 安装包：`electron-builder.yml` 只打包 `desktop/out/**`。
- 输出目录含私钥，禁止提交、禁止放进客户环境。
- 自检覆盖：签发后回读验签、委托公钥一致性、过期后按 `expired` 拒绝。
