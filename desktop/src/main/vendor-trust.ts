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
const EMBEDDED_VENDOR_PUBLIC_KEY: RsaPublicKeyParams | null = null

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
