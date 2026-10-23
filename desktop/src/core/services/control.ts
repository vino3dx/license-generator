import type { KeyObject } from 'node:crypto'
import {
  countBoundDevices,
  findActiveControlCertificate,
  findLatestControlCertificate,
  saveControlCertificate,
  withTransaction,
  type ControlCertificateRecord
} from '@core/db'
import { isLicenseError } from '@core/license/errors'
import { formatTimestamp } from '@core/license/encoding'
import { verifyVendorCertificate, type VerifiedVendorCertificate } from '@core/license/vendor-license'
import type { ControlCertificateDto, QuotaUsageDto } from '@shared/license/service-contract'
import type { VendorControlPayload } from '@shared/license/protocol'
import { writeAudit } from './audit'
import type { ResolvedDependencies } from './context'
import { ServiceError } from './errors'

export interface VerifiedControlCertificate {
  readonly record: ControlCertificateRecord
  readonly verified: VerifiedVendorCertificate
  readonly payload: VendorControlPayload
  /** null 表示不限项目（payload.project_ids 为 ["*"]） */
  readonly scope: readonly string[] | null
}

const WILDCARD = '*'

/**
 * 导入厂商中控证书：先验签再落库，任何验签失败都不会写入。
 * 同一时刻只保留一张生效证书。
 */
export function importControlCertificate(
  deps: ResolvedDependencies,
  envelopeText: string
): ControlCertificateDto {
  // 信任根缺失时不能“先导入再说”：没有公钥就无法验证这张证书是谁签的
  const vendorKey = requireVendorKey(deps)
  const now = deps.now()
  const at = formatTimestamp(now)
  const text = typeof envelopeText === 'string' ? envelopeText.trim() : ''

  let verified: VerifiedVendorCertificate
  try {
    verified = verifyVendorCertificate(text, vendorKey, now.getTime())
  } catch (error) {
    const code = mapControlError(error)
    writeAudit(deps, {
      at,
      action: 'control_certificate_import',
      targetType: 'control-certificate',
      targetId: 'unknown',
      result: 'failure',
      errorCode: code,
      context: null
    })
    throw new ServiceError(code, `中控证书不可用: ${asMessage(error)}`)
  }

  const payload = verified.payload
  const record: ControlCertificateRecord = {
    licenseId: payload.license_id,
    kid: verified.controlKeyId,
    envelope: text,
    issuedAt: payload.issued_at,
    expiresAt: payload.expires_at,
    importedAt: at,
    isActive: true,
    projectIds: payload.project_ids,
    maxDevices: payload.max_devices,
    // 约定 v3.1 §1：features 固定空数组；协议 v3 payload 已不含该字段，仅本地记录保留
    features: []
  }

  withTransaction(deps.database, () => {
    saveControlCertificate(deps.database, record)
    writeAudit(deps, {
      at,
      action: 'control_certificate_import',
      targetType: 'control-certificate',
      targetId: payload.license_id,
      result: 'success',
      errorCode: null,
      context: JSON.stringify({
        expiresAt: payload.expires_at,
        maxDevices: payload.max_devices,
        projectIds: payload.project_ids
      })
    })
  })

  return toControlCertificateDto(record, payload)
}

/**
 * 读取并重新验证当前生效的中控证书。
 * 每次签发都调用：数据库里的记录不被信任，签名与有效期都要重新算。
 */
export function loadVerifiedControlCertificate(deps: ResolvedDependencies): VerifiedControlCertificate {
  const vendorKey = requireVendorKey(deps)
  const record = findActiveControlCertificate(deps.database)
  if (record === null) {
    throw new ServiceError('control_certificate_missing', '尚未导入中控授权证书')
  }
  const now = deps.now()
  let verified: VerifiedVendorCertificate
  try {
    verified = verifyVendorCertificate(record.envelope, vendorKey, now.getTime())
  } catch (error) {
    throw new ServiceError(mapControlError(error), `中控证书不可用: ${asMessage(error)}`)
  }
  const payload = verified.payload
  const scope = payload.project_ids.includes(WILDCARD) ? null : payload.project_ids
  return { record, verified, payload, scope }
}

/**
 * 最近导入的一张证书（含已作废），只用于界面提示。
 * 一次性证书规则下签发成功后证书即 inactive：这里仍尝试验签以取回 payload，
 * 验签不过（例如证书随后过期）时退回数据库记录，payload 相关字段留空。
 */
export function loadLatestControlCertificate(deps: ResolvedDependencies): ControlCertificateDto | null {
  const record = findLatestControlCertificate(deps.database)
  if (record === null) {
    return null
  }
  if (record.isActive) {
    return toControlCertificateDto(record, loadVerifiedControlCertificate(deps).payload)
  }
  try {
    const verified = verifyVendorCertificate(record.envelope, requireVendorKey(deps), deps.now().getTime())
    return toControlCertificateDto(record, verified.payload)
  } catch {
    return {
      licenseId: record.licenseId,
      kid: record.kid,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      importedAt: record.importedAt,
      isActive: false,
      projectIds: [],
      maxDevices: 0,
      features: []
    }
  }
}

/** 额度使用情况：范围内未解绑的登记设备数（锁定设备仍占用） */
export function quotaUsage(
  deps: ResolvedDependencies,
  certificate: VerifiedControlCertificate
): QuotaUsageDto {
  const used = countBoundDevices(deps.database, certificate.scope)
  return {
    controlLicenseId: certificate.payload.license_id,
    maxDevices: certificate.payload.max_devices,
    usedDevices: used
  }
}

export function toControlCertificateDto(
  record: ControlCertificateRecord,
  payload: VendorControlPayload
): ControlCertificateDto {
  return {
    licenseId: record.licenseId,
    kid: record.kid,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    importedAt: record.importedAt,
    isActive: record.isActive,
    projectIds: payload.project_ids,
    maxDevices: payload.max_devices,
    // 约定 v3.1 §1：features 固定空数组，不使用、不传递
    features: []
  }
}

function requireVendorKey(deps: ResolvedDependencies): KeyObject {
  if (deps.vendorKeyObject === null) {
    throw new ServiceError(
      'vendor_key_missing',
      '未配置厂商公钥，无法验证中控授权证书；请使用带正式公钥的构建'
    )
  }
  return deps.vendorKeyObject
}

function mapControlError(error: unknown): 'control_certificate_invalid' | 'control_certificate_expired' {
  if (isLicenseError(error) && (error.code === 'expired' || error.code === 'not_yet_valid')) {
    return 'control_certificate_expired'
  }
  return 'control_certificate_invalid'
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
