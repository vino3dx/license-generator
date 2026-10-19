# License Generator

离线授权管理系统，专为 **Godot 4.x** 项目设计。

包含两部分：

1. **Python 授权文件生成器**（`src/license_generator.py`）—— 用于生成加密的 `license.dat`
2. **Godot 4 插件**（`godot/addons/license_manager`）—— 在游戏中验证授权

支持到期时间校验、项目标识绑定、系统时钟防回拨检测等功能。

---

## 功能特性

- AES-256-CBC 加密授权文件
- 每个项目独立派生密钥（密码 + 项目标识）
- 支持授权天数 / 到期日期设置
- 随机 IV，防止固定模式攻击
- 项目标识校验，防止跨项目复用授权文件
- 系统时钟回拨检测
- Godot 编辑器 Dock 面板可视化状态
- 自动注册 `LicenseManager` 单例

---

## 项目结构

```
license-generator/
├── src/
│   └── license_generator.py      # Python 授权生成器（GUI）
└── godot/
    └── addons/
        └── license_manager/      # Godot 4 授权验证插件
            ├── plugin.cfg
            ├── license.gd
            ├── license_manager.gd
            ├── license_key.gd     # 项目专属密钥（需由生成器导出覆盖）
            ├── license_dock.gd
            └── license_config.cfg
```

---

## 使用流程

### 1. 准备生成器

1. 安装依赖：
   ```bash
   pip install pycryptodome
   ```
2. **重要安全配置**（首次使用必须修改）：
   - 打开 `src/license_generator.py`
   - 修改 `ADMIN_PASSWORD_HASH`（管理员密码的 SHA256 哈希）
   - 修改 `STATIC_PEPPER`（建议换成随机字符串）

   生成密码哈希示例：
   ```bash
   python -c "import hashlib; print(hashlib.sha256('你的新密码'.encode()).hexdigest())"
   ```

3. 运行生成器：
   ```bash
   python src/license_generator.py
   ```

### 2. 为 Godot 项目配置密钥

1. 在生成器中填写**项目标识**（每个项目固定且唯一，例如 `MY_GAME_2026`）
2. 点击 **「导出该项目的 Godot 密钥文件」**
3. 将生成的 `license_key.gd` 覆盖到 Godot 项目的：
   ```
   addons/license_manager/license_key.gd
   ```

### 3. 生成授权文件

1. 填写相同的项目标识
2. 设置授权天数或到期日期
3. 点击 **「生成授权文件」**
4. 将生成的 `license.dat` 放到：
   - 编辑器运行：项目根目录
   - 导出后的游戏：与可执行文件同目录

### 4. 在 Godot 中启用插件

1. 将 `godot/addons/license_manager` 复制到你的 Godot 项目 `addons/` 目录
2. 在 **项目 → 项目设置 → 插件** 中启用 `license_manager`
3. 插件会自动注册全局单例 `LicenseManager`

---

## 授权验证逻辑说明

插件在启动时会自动执行以下检查：

| 检查项           | 说明                              |
|------------------|-----------------------------------|
| 文件存在性       | 是否存在 `license.dat`            |
| 解密成功         | AES-256-CBC 解密是否正常          |
| 项目标识匹配     | 是否与 `license_key.gd` 中一致    |
| 日期合法性       | 签发日期 ≤ 到期日期               |
| 时钟回拨检测     | 防止用户修改系统时间绕过授权      |
| 是否过期         | 当前日期是否超过到期日            |

验证失败时游戏会直接退出。

---

## 开发注意事项

- **每个项目必须使用独立的 `license_key.gd`**，不要跨项目复制。
- 管理员密码只保存在内存中用于派生密钥，不会落盘。
- 源码中只保存密码的 SHA256 哈希，不会暴露明文密码。
- `STATIC_PEPPER` 建议每个使用者自行更换。
- 建议在正式发布前充分测试时钟回拨和过期场景。

---

## 环境要求

### 生成器端
- Python 3.8+
- `pycryptodome`

### Godot 端
- Godot 4.x（推荐 4.2+ / 4.6+）

---

## 安全建议

1. 首次使用务必修改密码哈希和 `STATIC_PEPPER`
2. 不要将包含真实密钥的 `license_key.gd` 提交到公开仓库
3. 生成器程序建议只在内部使用，不要分发给最终用户
4. 授权文件 `license.dat` 可安全分发给客户

---

## 作者

Vino

---

## 许可证

本项目仅供学习与内部使用。请根据自身需求自行决定开源协议。
