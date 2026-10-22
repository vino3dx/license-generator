import { createPublicKey, type KeyObject } from 'node:crypto'
import { CLOCK_SKEW_MS, type RsaPublicKeyParams, type VendorControlPayload } from '@shared/license/protocol'
import { createEnvelope, openEnvelope } from './envelope'
import { LicenseError } from './errors'
import { assertTimeWindow, buildVendorPayload, parseVendorPayload, type VendorCertificateInput } from './payloads'
import {
  computeKeyId,
  exportPublicKeyParams,
  importPublicKeyParams,
  validatePublicKeyParams
} from './rsa-keys'

export interface VerifiedVendorCertificate {
  readonly licenseId: string
  readonly payload: VendorControlPayload
  readonly delegatedPublicKeyParams: RsaPublicKeyParams
  readonly delegatedPublicKey: KeyObject
  readonly delegatedKeyId: string
  readonly controlKeyId: string
  readonly expiresAt: number
}

export interface IssuedVendorCertificate {
  readonly envelope: string
  readonly payload: VendorControlPayload
  readonly payloadBytes: Buffer
}

/**
 * 厂商签发工具使用：用厂商私钥签署中控授权证书。
 * 私钥只能存在于厂商环境，客户应用不得调用本函数的密钥来源。
 */
export function issueVendorCertificate(
  input: VendorCertificateInput,
  vendorPrivateKey: KeyObject
): IssuedVendorCertificate {
  const { payload, bytes } = buildVendorPayload(input)
  // 提前校验委托公钥强度，避免签发出去一个子机无法使用的证书
  validatePublicKeyParams(payload.delegated_public_key)
  const envelope = createEnvelope(bytes, 'vendor-control', vendorPrivateKey)
  return { envelope, payload, payloadBytes: bytes }
}

/**
 * 客户中控使用：用厂商公钥验证中控授权证书。
 * 顺序：验签 → 解析 payload → 时间窗口 → 委托公钥强度。
 */
export function verifyVendorCertificate(
  text: string,
  vendorPublicKey: KeyObject,
  now: number = Date.now()
): VerifiedVendorCertificate {
  const opened = openEnvelope(text, 'vendor-control', vendorPublicKey)
  const payload = parseVendorPayload(opened.payloadBytes)
  assertTimeWindow(payload.issued_at, payload.expires_at, now, CLOCK_SKEW_MS)

  const delegatedPublicKeyParams = validatePublicKeyParams(payload.delegated_public_key)
  const delegatedPublicKey = importPublicKeyParams(delegatedPublicKeyParams)

  return {
    licenseId: payload.license_id,
    payload,
    delegatedPublicKeyParams,
    delegatedPublicKey,
    delegatedKeyId: computeKeyId(delegatedPublicKey),
    controlKeyId: opened.envelope.kid,
    expiresAt: Date.parse(payload.expires_at)
  }
}

export function exportVendorPublicKeyParams(vendorPrivateKey: KeyObject): RsaPublicKeyParams {
  return exportPublicKeyParams(requirePublicKey(vendorPrivateKey))
}

export function isProjectAllowed(certificate: VerifiedVendorCertificate, projectId: string): boolean {
  const scoped = certificate.payload.project_ids
  return scoped.includes('*') || scoped.includes(projectId)
}

export function assertProjectAllowed(
  certificate: VerifiedVendorCertificate,
  projectId: string
): void {
  if (!isProjectAllowed(certificate, projectId)) {
    throw new LicenseError('project_not_allowed', `项目 ${projectId} 不在中控授权范围内`)
  }
}

function requirePublicKey(key: KeyObject): KeyObject {
  return key.type === 'public' ? key : createPublicKey(key)
}
