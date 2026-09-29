# Aegis 3.0 — 离线授权

```
aegis/
├─ godot/     Godot 工程 + addons/aegis 插件
└─ python/    aegis_generator.py 授权生成器 (pip install -r requirements.txt)
```

## 日常流程
1. Godot 里启用插件(工程已启用),右侧 Dock 可看到 **项目 ID** 与 **密钥指纹**。
2. 运行 `python/aegis_generator.py` → 登录 → 密钥与项目 ID 自动读取(指纹应与 Dock 一致)→ 填客户、天数或到期日 → 生成 `license.dat`。
3. 把 `license.dat` 放到导出 exe 的同一目录。

**打包后取项目 ID(推荐)**: Dock 里复制「导出标记」→ 导出预设 → Windows → 应用程序 → 商标(Trademarks) 粘贴(一次即可,改工程名/密钥后需更新)→ 导出。生成器点「从导出的 exe 读取」即可自动填入项目 ID,并比对密钥指纹。

## 3.0 相对 2.x 的变化
- **改名**: `license_manager` → `aegis`;autoload 名 `LicenseManager` → `Aegis`。
- **密钥单点维护**: 只改 `godot/addons/aegis/aegis_secret.gd`,生成器自动读取,不再两边手动同步。
- **项目 ID 自动算**: 生成器可直接读 `project.godot` 的工程名,算法与插件一致。
- **日期改用本地日期**(旧版用 UTC,中国时区会晚 8 小时失效)。到期日含当天,次日 0 点失效。
- **运行中复查**: 启动校验 + 每 10 分钟 + 窗口重新获得焦点时复查,长时间开着的程序也会到期退出。
- **失败有提示**: 弹窗说明原因和错误码后退出(旧版静默退出)。
- **导出版强制校验**: `aegis.cfg` 的关闭开关只在编辑器内生效。
- **autoload 不再被抹掉**: 旧版在 `_exit_tree` 删除 autoload,关编辑器时会把它从 project.godot 移除;现改为仅在启用/停用插件时增删,Dock 还会在缺失时红字警告。
- **防回拨**: 时间记录加校验、允许 6 小时误差;记录损坏时不误伤客户。
- **生成器**: 去掉 TEST_MODE,签发日期可编辑(可造"已到期"测试授权);新增客户备注、生成后解密自检、覆盖确认、`issued_licenses.csv` 签发记录、记住上次目录;修复 PyInstaller 打包后默认目录错误。
- 授权 JSON 新增 `v`、`customer` 字段。

## 注意
- **改工程名 / 改密钥 = 所有旧授权失效**,需重新签发。
- `godot/license.dat` 是开发测试用样例(工程名 aegis,有效期至 2027-03-31),正式使用前请自己重新生成。
- 发布前务必把 `aegis_secret.gd` 里的默认密钥换成自己的随机串,并用 `python aegis_generator.py --hash 新密码` 换掉管理员密码哈希。
- 离线 + 对称密钥的固有局限: 密钥在 exe 内可被提取,时间记录可被删除。防君子不防高手;需要更强再升级 RSA 签名。

## 打包生成器
`pyinstaller --onefile --windowed aegis_generator.py` (把 exe 放在 aegis/python/ 下即可自动找到 godot/ 里的密钥)
