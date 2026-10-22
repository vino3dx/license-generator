import type { KeyObject } from 'node:crypto'
import { CLOCK_SKEW_MS, type MachineLicensePayload } from '@shared/license/protocol'
import { createEnvelope, openEnvelope } from './envelope'
import { LicenseError } from './errors'
import { assertTimeWindow, buildMachinePayload, parseMachinePayload, type MachineLicenseInput } from './payloads'
import { assertProjectAllowed, type VerifiedVendorCertificate } from './vendor-license'

export interface IssuedMachineLicense {
  readonly envelope: string
  readonly payload: MachineLicensePayload
  readonly payloadBytes: Buffer
}

export interface MachineLicenseExpectation {
  readonly projectId: string
  readonly deviceId: string
}

export interface VerifiedMachineLicense {
  readonly licenseId: string
  readonly payload: MachineLicensePayload
  readonly expiresAt: number
}

/**
 * 客户中控使用委托私钥签发子机授权。
 * 调用方（业务层）必须先用 verifyVendorCertificate 确认中控证书有效，
 * 再调用本函数；这里不代替业务层的额度/范围校验。
 */
export function issueMachineLicense(
  input: MachineLicenseInput,
  delegatedPrivateKey: KeyObject
): IssuedMachineLicense {
  const { payload, bytes } = buildMachinePayload(input)
  const envelope = createEnvelope(bytes, 'machine-license', delegatedPrivateKey)
  return { envelope, payload, payloadBytes: bytes }
}

/**
 * 子机/中控校验子机授权：
 * 1. 用中控证书里的委托公钥验签；
 * 2. 解析 payload 并做时间窗口校验；
 * 3. 绑定中控证书 ID、状态、项目范围、设备 ID；
 * 4. 有效期不得超过中控证书有效期。
 */
export function verifyMachineLicense(
  text: string,
  certificate: VerifiedVendorCertificate,
  expected: MachineLicenseExpectation,
  now: number = Date.now()
): VerifiedMachineLicense {
  const opened = openEnvelope(text, 'machine-license', certificate.delegatedPublicKey)
  const payload = parseMachinePayload(opened.payloadBytes)

  if (now >= certificate.expiresAt) {
    throw new LicenseError('expired', '中控授权证书已过期')
  }
  assertTimeWindow(payload.issued_at, payload.expires_at, now, CLOCK_SKEW_MS)

  if (payload.control_license_id !== certificate.licenseId) {
    throw new LicenseError('control_license_mismatch', '子机授权不属于当前中控证书')
  }
  if (payload.status !== 'active') {
    throw new LicenseError('status_inactive', '子机授权状态不是 active')
  }
  assertProjectAllowed(certificate, payload.project_id)
  if (payload.project_id !== expected.projectId) {
    throw new LicenseError('project_not_allowed', '子机授权的项目与子机自报项目不一致')
  }
  if (payload.device_id !== expected.deviceId) {
    throw new LicenseError('device_mismatch', '子机授权的设备 ID 与子机自报设备不一致')
  }
  if (Date.parse(payload.expires_at) > certificate.expiresAt) {
    throw new LicenseError('payload_invalid', '子机授权有效期不得超出中控证书有效期')
  }

  return {
    licenseId: payload.license_id,
    payload,
    expiresAt: Date.parse(payload.expires_at)
  }
}
