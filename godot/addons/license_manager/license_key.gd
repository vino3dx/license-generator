extends RefCounted
class_name LicenseKeyData

## ⚠️ 本文件是"每个项目独立"的密钥载体，不同项目必须使用不同的一份，
## 不能跨项目复制粘贴使用。
##
## 内容由 license_generator.py 的「导出该项目的 Godot 密钥文件」功能生成。
## PROJECT_CODE 必须和生成 license.dat 时填写的"项目标识"完全一致，
## DERIVED_KEY_B64 是 密码 + 项目标识 派生出的 AES-256 密钥（Base64 编码）。
## 这里面不包含密码本身，也无法从这个值反推出密码。
##
## 使用方法：
## 1. 在生成器里填好这个项目的"项目标识"
## 2. 点击「导出该项目的 Godot 密钥文件」，保存出的 license_key.gd
## 3. 用保存出来的文件覆盖本模板文件，放入
##    addons/license_manager/license_key.gd
## 4. 再用同一个项目标识生成对应的 license.dat 授权文件

const PROJECT_CODE := "CHANGE_ME_PROJECT_CODE"
const DERIVED_KEY_B64 := "CHANGE_ME_BASE64_DERIVED_KEY"
