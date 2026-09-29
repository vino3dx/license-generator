extends RefCounted
## Aegis 共享密钥 —— 整个体系中唯一需要改密钥的地方。
## python/aegis_generator.py 会自动读取本文件里的 SHARED_SECRET,无需再手动同步。
## 发布前请改成你自己的随机字符串(不要包含反斜杠和双引号)。
## 注意:修改后,所有已签发的 license.dat 都会失效,需要重新签发。

const SHARED_SECRET := "MyStudio_Secret_2026"
