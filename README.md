# Aegis — 离线授权（aegis-license/v1）

```
aegis/
├─ godot/              Godot 工程 + addons/aegis 插件 + addons.zip 分发包
├─ desktop/            中控主机（Electron + Vue 3 + TypeScript）：签发 / 管理授权
│  ├─ src/core/license 协议实现（信封、RS256、严格 JSON）
│  ├─ docs/            协议文档 license-protocol.md
│  ├─ verifier-godot/  GDScript 验签器源码（同步进 Godot 插件）
│  └─ tests/           协议与 Godot 联调测试
└─ python/             旧版 AES 授权生成器（见文末「历史组件」）
```

## 授权模型

两层 RSA 证书链（RSASSA-PKCS1-v1_5 + SHA-256，2048 位）：

1. 厂商用**厂商私钥**签发中控授权证书 `control.cert`（`vendor-control`），证书里带委托公钥；
2. 客户中控用**委托私钥**签发子机授权 `license.dat`（`machine-license`）；
3. 子机用插件内置的**厂商公钥**验证书，再用证书内的委托公钥验子机授权，
   并校验项目 ID、设备 ID、状态、有效期与时钟。

协议细节：`desktop/docs/license-protocol.md`。

## 日常流程

1. Godot 工程启用 Aegis 插件，Dock 显示**项目 ID**、**设备 ID**、**密钥指纹**；
2. 中控主机导入 `control.cert`，按项目 ID + 设备 ID 签发子机授权；
3. 把 `control.cert` 与 `license.dat` 放到工程根目录（导出后放 exe 同目录）；
4. 运行 / 导出。授权无效时插件会暂停场景、显示错误码并以退出码 1 结束进程。

Godot 侧的安装、配置、错误码与测试方式见 [`godot/README.md`](godot/README.md)。

## 分发包

```bash
python godot/package_addons.py     # 重新生成 godot/addons.zip
```

## 注意

- 厂商公钥当前仍是**空占位**（`godot/addons/aegis/aegis_vendor_key.gd`），
  空公钥会让所有授权以 `0x062` 失败——这是刻意的 fail-closed，不是缺陷；
  发布前必须替换为生产公钥并重新打包。
- 生产授权链路与正式导出验收**尚未完成**，详见 `godot/README.md` 第 9 节。
- 改工程名会改变项目 ID，所有旧授权失效，需要重新签发。

## 历史组件

`python/aegis_generator.py` 是 3.x 时代的 **AES-256-CBC 对称加密**生成器，产出的是旧格式
`license.dat`，与当前插件的 `aegis-license/v1` 信封格式**不兼容**，请勿用于新授权。
它保留在仓库中仅为兼容旧版本客户，后续是否下线由中控侧统一决定。
