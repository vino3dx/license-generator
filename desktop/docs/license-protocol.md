# Aegis 授权协议 v1（`aegis-license/v1`）

本协议定义两层授权链：

1. 厂商签发**中控授权证书**（`vendor-control`），内含委托公钥；
2. 客户中控用委托私钥签发**子机授权**（`machine-license`）；
3. 子机用内置厂商公钥验中控证书，再用证书内的委托公钥验子机授权。

签名算法统一为 **RSASSA-PKCS1-v1_5 + SHA-256（RS256）**，密钥长度 2048 位。协议不依赖任何语言的序列化实现差异：被签名的永远是**确切的字节串**。

实现位置：

- TypeScript：`src/core/license/`
- GDScript（子机侧验签）：`verifier-godot/aegis_rsa_verify.gd`
- 测试向量：`tests/fixtures/vectors.json`（由 `AEGIS_WRITE_VECTORS=1 npm test` 重建，测试中自动比对）

## 1. 通用编码规则

| 项目 | 规定 |
| --- | --- |
| 文本编码 | UTF-8，无 BOM |
| JSON 形式 | 签发方必须输出紧凑 JSON（无空白、无换行、无结尾换行）；验签方容忍 token 之间的空白，但拒绝重复键与尾部多余内容 |
| Base64URL | RFC 4648 §5 字母表 `A-Za-z0-9-_`，**无填充**（不得出现 `=`） |
| Base64URL 解码 | 必须严格：非法字符、`=`、长度 `% 4 == 1`、非规范尾部位一律拒绝 |
| 时间 | `YYYY-MM-DDTHH:MM:SSZ`（UTC、秒级、无小数秒、无时区偏移），如 `2026-10-22T00:00:00Z` |
| 整数 | 十进制、无符号、无前导零、无小数与指数，范围 `0 .. 2^53-1` |
| 标识符 | `license_id` / `project_id` / `device_id` / `feature`：`[A-Za-z0-9._:-]{1,128}` |
| 长度上限 | 信封 ≤ 16384 字节；payload ≤ 8192 字节；RSA 签名固定 256 字节；模数固定 256 字节 |
| 未知版本 | `schema_version` 不等于 `1`（含类型不是整数）→ 拒绝（`unsupported_version`），不得尝试兼容解析 |
| 未知字段 | 拒绝（`payload_invalid`）。payload 与信封的键集合必须与本文档完全一致 |
| 重复键 | 两端都拒绝（`payload_malformed` / `envelope_malformed`），含嵌套对象 |
| 字符串 | 拒绝裸控制字符（< 0x20）与未知转义；`\u` 必须 4 位十六进制；拒绝孤立代理项 |

## 2. 信封（Envelope）

信封是外层 JSON 文本，**本身不签名**，只用于承载算法标识、密钥标识、payload 与签名。字段顺序固定如下（仅约束签发方输出；验签方不得依赖顺序）：

```json
{
  "aegis": "license-envelope",
  "schema_version": 1,
  "license_type": "vendor-control",
  "alg": "RS256",
  "kid": "<base64url(sha256(公钥 DER SPKI))>",
  "payload": "<base64url(payload 字节)>",
  "signature": "<base64url(签名 256 字节)>"
}
```

约束：

- `aegis` 必须为 `license-envelope`；否则 `envelope_malformed`。
- `license_type` 只能是 `vendor-control` 或 `machine-license`；调用方必须声明期望类型，不一致 → `type_mismatch`。
- `alg` 必须为 `RS256`；否则 `unsupported_algorithm`。
- `kid` 是公钥指纹（43 字符 base64url），用于选键与审计；验签方不得仅凭 `kid` 信任公钥。
- `signature` 必须正好是模数字节长度（2048 位 → 256 字节），且作为大端整数必须 `< n`。

## 3. 签名对象

被签名数据 = `payload` 字段 Base64URL 解码后的**原始字节**。

- 不得在验签前重新序列化、重排字段、裁剪空白、统一换行或做编码转换；
- 验签通过后才允许把同一段字节解析为 JSON 并做业务校验；
- payload 中所有影响授权决策的字段都在签名覆盖范围内（因为签名覆盖整个字节串）。

验签顺序（两种类型都适用）：

1. 长度/G UTF-8 检查 → 解析信封（键集合、类型、枚举）→ `envelope_malformed` / `unsupported_*` / `type_mismatch`
2. 严格 Base64URL 解码 `payload` 与 `signature` → `base64url_invalid`
3. 签名长度与取值范围检查 → `signature_length` / `signature_out_of_range`
4. 对 payload 原始字节做 RS256 验签 → `signature_invalid`
5. 解析 payload JSON（严格）→ `payload_malformed`
6. 字段/类型/长度/时间/范围校验 → `payload_invalid`
7. 业务校验（项目范围、设备、额度、状态）→ `project_not_allowed` / `device_mismatch` / `status_inactive` 等

## 4. payload：中控授权证书（`vendor-control`）

签发方：厂商签发工具（厂商私钥只在厂商环境中）。字段顺序即下列顺序：

```json
{
  "schema_version": 1,
  "license_type": "vendor-control",
  "license_id": "VND-2026-0001",
  "issued_at": "2026-10-01T00:00:00Z",
  "expires_at": "2027-10-01T00:00:00Z",
  "project_ids": ["proj-a", "proj-b"],
  "max_devices": 50,
  "features": ["device.lock", "license.issue"],
  "delegated_public_key": { "kty": "RSA", "n": "<base64url 256 字节>", "e": "AQAB" }
}
```

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `schema_version` | 整数 | 必须为 `1` |
| `license_type` | 字符串 | 必须为 `vendor-control`，且与信封一致 |
| `license_id` | 标识符 | 中控证书唯一 ID |
| `issued_at` | 时间 | ≤ 校验时刻 + 5 分钟时钟容差 |
| `expires_at` | 时间 | 必须 `> issued_at` |
| `project_ids` | 字符串数组 | 非空、去重、升序；单元素 `"*"` 表示不限项目 |
| `max_devices` | 整数 | `1 .. 1000000` |
| `features` | 字符串数组 | 可空、去重、升序，元素为标识符 |
| `delegated_public_key` | 对象 | 恰好 `kty`/`n`/`e` 三个字段，见 §6 |

## 5. payload：子机授权（`machine-license`）

签发方：客户中控（委托私钥）。字段顺序即下列顺序：

```json
{
  "schema_version": 1,
  "license_type": "machine-license",
  "license_id": "MCH-2026-0001-0001",
  "control_license_id": "VND-2026-0001",
  "project_id": "proj-a",
  "device_id": "DEV-0001",
  "issued_at": "2026-10-22T02:00:00Z",
  "expires_at": "2027-01-20T02:00:00Z",
  "status": "active",
  "features": ["device.lock"]
}
```

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `schema_version` | 整数 | 必须为 `1` |
| `license_type` | 字符串 | 必须为 `machine-license`，且与信封一致 |
| `license_id` | 标识符 | 子机授权唯一 ID |
| `control_license_id` | 标识符 | 必须等于所验证中控证书的 `license_id`（防跨中控复用） |
| `project_id` | 标识符 | 必须在中控证书的 `project_ids` 范围内 |
| `device_id` | 标识符 | 必须与子机自报设备 ID 一致 |
| `issued_at` | 时间 | ≤ 校验时刻 + 5 分钟时钟容差 |
| `expires_at` | 时间 | `> issued_at`，且 **≤ 中控证书 `expires_at`**（子机授权不得超出中控授权期） |
| `status` | 枚举 | `active` / `revoked`；仅 `active` 可放行 |
| `features` | 字符串数组 | 可空、去重、升序 |

## 6. RSA 公钥表示格式

协议内**只使用** modulus / exponent 形式，禁止在 Godot 侧解析 PEM/DER：

```json
{ "kty": "RSA", "n": "<base64url，大端无符号 256 字节>", "e": "<base64url，大端无符号，如 AQAB>" }
```

校验要求（Node 与 GDScript 两端一致）：

- `n` 解码后正好 256 字节，且最高位为 1（即确实是 2048 位模数），最低位为 1（奇数）；
- `e` 解码后 1~4 字节，值为奇数且 `65537 ≤ e < 2^32`；
- 签名长度 = 256 字节，签名整数 `< n`；
- `kid = base64url(sha256(SPKI DER))`，Node 侧生成并写入信封；GDScript 侧不计算，只记录。

## 7. PKCS#1 v1.5 填充（EM 结构）

验签时还原出的 EM 必须是：

```
0x00 || 0x01 || 0xFF * k || 0x00 || DigestInfo(SHA-256)
```

其中 `k = 256 - 3 - 19 - 32`，`DigestInfo = 3031300d060960864801650304020105000420`（19 字节），随后是 32 字节 SHA-256 摘要。任何偏离（填充字节数、0x00 位置、DigestInfo 前缀）都判为 `signature_invalid`。

## 8. 两层校验链

子机验签流程：

1. 用**内置厂商公钥**验证中控证书信封 → 得到 `vendor-control` payload；
2. 校验证书时间窗口、项目范围、`max_devices` 等策略（额度由中控侧在签发时执行，子机侧只读）；
3. 取 `payload.delegated_public_key` 构造委托公钥，按 §6 校验强度；
4. 用委托公钥验证子机授权信封 → 得到 `machine-license` payload；
5. 校验 `control_license_id` 与第 1 步一致、`project_id`/`device_id` 匹配、`status=active`、有效期不超过中控证书。

禁止把厂商私钥或委托私钥放进 Godot 项目或子机授权文件。

## 9. 已知限制（必须如实告知客户）

- 委托私钥保存在客户中控上，普通 Windows 环境无法保证不可提取；本协议只提高伪造门槛，不宣称抵御专业逆向。
- 子机离线时无法立即撤销：`status` 是签发时刻的快照，不代表实时状态。
- 本地时间回拨无法可靠防御；阶段 1~2 不做时间锚定。Godot 插件保留了旧版的运行时间记录（`user://aegis_time.dat`），只做弱校验，不宣称能抵御改系统时间。
- 重复 JSON 键：Node 与 GDScript 两端都严格拒绝（`payload_malformed` / `envelope_malformed`），包括嵌套对象中的重复键。GDScript 侧由 `aegis_strict_json.gd` 逐字符解析，不使用正则检测。
- 孤立 UTF-16 代理项（如 `\uD800`）两端都拒绝：它在 UTF-8 中无法表示，放行会导致两种语言解析出不同字符串。
- `features` 目前只是声明，业务语义在阶段 3 定义。

## 10. 测试向量

`tests/fixtures/vectors.json` 固定记录：

- 两把测试密钥（厂商、委托）与一把"错误公钥"的公钥参数、`kid`、以及 Montgomery 预计算量 `n0inv` / `R² mod n`（用于交叉校验 GDScript 实现）；
- 中控证书与子机授权的完整信封文本、payload 原始字节（Base64URL + SHA-256）；
- 正向与负向用例，含期望结果与期望错误码。

测试密钥仅用于自动化测试，文件名与 README 均标注 `TEST ONLY`；构建产物只包含 `out/`，不包含 `tests/`。
