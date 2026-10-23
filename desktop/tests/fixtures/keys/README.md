# TEST ONLY

本目录的三把 RSA-2048 私钥**仅用于自动化测试与测试向量生成**：

- `vendor-test.private.pem`：模拟厂商私钥
- `delegate-test.private.pem`：模拟客户中控的委托签发私钥
- `rogue-test.private.pem`：模拟攻击者密钥，用于负向测试

约束：

1. 不得用于任何真实签发，不得作为正式厂商密钥。
2. 不得复制到 `src/`、`out/`、`release/` 或任何随应用分发的位置；`electron-builder.yml` 只打包 `out/**`。
3. 正式厂商私钥只应存在于厂商自己的签发环境，不进入本仓库。

`tests/vectors/vectors.json`（仓库级）由 `AEGIS_WRITE_VECTORS=1 npm test` 生成，Node 与 Godot 两侧共用。
