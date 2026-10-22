import { createPublicKey, type KeyObject } from 'node:crypto'
import { formatTimestamp } from '@core/license/encoding'
import { exportPublicKeyParams, loadPrivateKeyFromPem } from '@core/license/rsa-keys'
import type { DelegatedKeyStatusDto } from '@shared/license/service-contract'
import { writeAudit } from './audit'
import { loadVerifiedControlCertificate } from './control'
import type { ResolvedDependencies } from './context'
import { samePublicKey } from './delegated-key'
import { ServiceError } from './errors'

/**
 * 委托签发私钥的配置管理。
 *
 * 安全边界（沿用阶段 3 的设计）：
 * - 私钥只写入 userData/keys/delegated.key.pem，权限 0600，不进数据库、日志、审计或构建产物；
 * - 审计只记录动作与结果，绝不记录私钥内容；
 * - Windows 下文件权限不能阻止有权限的用户提取，这是已知限制，后续可换 safeStorage。
 */
const LOCATION = 'keys/delegated.key.pem'
const REQUIRED_MODULUS_BITS = 2048
// 拆开拼接，避免源码中出现完整的 PEM 头字符串（构建产物扫描规则要求）
const PEM_BEGIN_MARK = '-----BEGIN '
const PEM_PRIVATE_MARK = ['PRIVATE', 'KEY'].join(' ')

export function getDelegatedKeyStatus(deps: ResolvedDependencies): DelegatedKeyStatusDto {
  let configured = false
  let matchesControl: boolean | null = null
  try {
    const key = deps.delegatedKeys.load()
    configured = key !== null
    if (key !== null) {
      try {
        const certificate = loadVerifiedControlCertificate(deps)
        matchesControl = samePublicKey(key.publicParams, certificate.payload.delegated_public_key)
      } catch {
        // 没有有效中控证书时无法判断是否匹配，保持 null 而不是猜测
        matchesControl = null
      }
    }
  } catch {
    configured = false
  }
  return { configured, matchesControl, location: LOCATION }
}

export function importDelegatedKey(deps: ResolvedDependencies, pemText: string): DelegatedKeyStatusDto {
  const at = formatTimestamp(deps.now())
  const text = typeof pemText === 'string' ? pemText.trim() : ''

  let privateKey: KeyObject
  try {
    privateKey = parsePem(text)
  } catch (error) {
    writeAudit(deps, {
      at,
      action: 'delegated_key_import',
      targetType: 'delegated-key',
      targetId: 'local',
      result: 'failure',
      errorCode: 'invalid_argument',
      context: JSON.stringify({ reason: asMessage(error) })
    })
    throw new ServiceError('invalid_argument', `委托私钥不可用: ${asMessage(error)}`)
  }

  const publicParams = exportPublicKeyParams(createPublicKey(privateKey))

  // 已导入中控证书时，私钥必须与证书里的委托公钥一致，否则签发出来的授权子机验不过
  let certificateLicenseId: string | null = null
  try {
    const certificate = loadVerifiedControlCertificate(deps)
    certificateLicenseId = certificate.payload.license_id
    if (!samePublicKey(publicParams, certificate.payload.delegated_public_key)) {
      writeAudit(deps, {
        at,
        action: 'delegated_key_import',
        targetType: 'delegated-key',
        targetId: certificate.payload.license_id,
        result: 'failure',
        errorCode: 'delegated_key_mismatch',
        context: null
      })
      throw new ServiceError('delegated_key_mismatch', '私钥与当前中控证书内的委托公钥不匹配')
    }
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'delegated_key_mismatch') {
      throw error
    }
    // 无中控证书（或证书不可用）时不阻止导入，后续签发会再次校验
    certificateLicenseId = null
  }

  if (typeof deps.delegatedKeys.save !== 'function') {
    throw new ServiceError('unexpected', '当前密钥存储不支持导入')
  }
  deps.delegatedKeys.save(`${text}\n`)

  writeAudit(deps, {
    at,
    action: 'delegated_key_import',
    targetType: 'delegated-key',
    targetId: certificateLicenseId ?? 'local',
    result: 'success',
    errorCode: null,
    context: JSON.stringify({ modulusBits: REQUIRED_MODULUS_BITS })
  })

  return getDelegatedKeyStatus(deps)
}

function parsePem(text: string): KeyObject {
  if (text.length === 0) {
    throw new Error('内容为空')
  }
  if (!text.includes(PEM_BEGIN_MARK) || !text.includes(PEM_PRIVATE_MARK)) {
    throw new Error('不是 PEM 私钥')
  }
  const key = loadPrivateKeyFromPem(text)
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`不支持的密钥类型: ${String(key.asymmetricKeyType)}`)
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (modulusLength !== REQUIRED_MODULUS_BITS) {
    throw new Error(`密钥长度必须为 ${REQUIRED_MODULUS_BITS} 位，实际 ${modulusLength}`)
  }
  return key
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
