extends RefCounted
## 厂商公钥 —— 编译期信任根
##
## 子机用这把公钥验证中控授权证书（vendor-control），证书里的委托公钥再验证子机授权。
## 公钥必须编译进脚本，不得来自配置文件、数据库或授权文件本身，否则信任根可被替换。
##
## 发布前必须把 `n` 替换为真实厂商公钥的 Base64URL（无填充，256 字节模数）。
## `n` 为空时 is_configured() 返回 false，所有授权校验都会失败（不会静默放行）。
##
## 开发/联调请勿修改本文件：联调脚本会把工程复制到临时目录再写入测试公钥，
## 避免测试密钥进入仓库或发布产物。

const VENDOR_PUBLIC_KEY := {
	"kty": "RSA",
	"n": "k4QuBSfdD87-0g9lnl4i45bILSsuEREIAF2NvyTLd_o87TC9otNg6oUhKaCVBi9za8Ir4xcQGr7ayySzBC10lFUziT3xmR1HgxW65Eqvcr3UK3_iIuOR-rumFtaCjEMeDFJf_TwHO4_HcXgqtg4MJGkvCVCRE5Ov2egzlb4_s8MClgc7R4oX2sllz36be2PnNPjdey7SVz1wpS9G80ffCtzQv7We8tpgC1vAICnDPPNClVzDVa_7wcxy89Om9s-RuISLYVtoS1IL43_FecP1ViG8QUZ4diajwOxo0MeRR_yoi6-60OF9zZ8_PflD44nG_IPbE2NaS5O7ysovH4oUuQ",
	"e": "AQAB"
}


static func is_configured() -> bool:
	var modulus = VENDOR_PUBLIC_KEY.get("n", "")
	return typeof(modulus) == TYPE_STRING and not String(modulus).is_empty()
