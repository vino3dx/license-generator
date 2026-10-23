import { validatePublicKeyParams } from '@core/license/rsa-keys'
import type { RsaPublicKeyParams } from '@shared/license/protocol'

/**
 * 厂商公钥 = 授权信任根，只应包含公钥，绝不包含私钥。
 *
 * 发布构建时把 null 替换为正式厂商公钥常量（这是唯一的信任根来源，不来自数据库或用户配置）。
 * 开发/测试环境可以通过 AEGIS_VENDOR_PUBLIC_KEY（JSON）注入测试公钥。
 *
 * 未配置时返回 null：运行时仍会初始化（项目管理、审计可用），
 * 但所有需要验证中控证书的操作都会 fail-closed 并返回 vendor_key_missing。
 */
const EMBEDDED_VENDOR_PUBLIC_KEY: RsaPublicKeyParams | null = {
  "kty": "RSA",
  "n": "k4QuBSfdD87-0g9lnl4i45bILSsuEREIAF2NvyTLd_o87TC9otNg6oUhKaCVBi9za8Ir4xcQGr7ayySzBC10lFUziT3xmR1HgxW65Eqvcr3UK3_iIuOR-rumFtaCjEMeDFJf_TwHO4_HcXgqtg4MJGkvCVCRE5Ov2egzlb4_s8MClgc7R4oX2sllz36be2PnNPjdey7SVz1wpS9G80ffCtzQv7We8tpgC1vAICnDPPNClVzDVa_7wcxy89Om9s-RuISLYVtoS1IL43_FecP1ViG8QUZ4diajwOxo0MeRR_yoi6-60OF9zZ8_PflD44nG_IPbE2NaS5O7ysovH4oUuQ",
  "e": "AQAB"
}

export function resolveVendorPublicKey(): RsaPublicKeyParams | null {
  if (EMBEDDED_VENDOR_PUBLIC_KEY !== null) {
    return validatePublicKeyParams(EMBEDDED_VENDOR_PUBLIC_KEY)
  }
  const injected = process.env['AEGIS_VENDOR_PUBLIC_KEY']
  if (injected === undefined || injected.trim().length === 0) {
    return null
  }
  // 注入了但内容非法属于配置错误，必须显式失败，不能静默降级为“未配置”
  return validatePublicKeyParams(JSON.parse(injected) as unknown)
}