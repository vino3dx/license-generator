import {
  LICENSE_SCHEMA_VERSION,
  MACHINE_PAYLOAD_KEYS,
  MAX_ENVELOPE_BYTES,
  VENDOR_PAYLOAD_KEYS,
  type MachineLicensePayload,
  type MachineLicenseStatus,
  type RsaPublicKeyParams,
  type VendorControlPayload
} from '@shared/license/protocol'
import {
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
  encodeUtf8,
  isIdentifier,
  isTimestamp,
  parseTimestamp
} from './encoding'
import { LicenseError } from './errors'
import { assertLicenseId, validatePublicKeyParams } from './rsa-keys'
import { parseStrictJson } from './strict-json'

export interface VendorCertificateInput {
  readonly licenseId: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly projectIds: readonly string[]
  readonly maxDevices: number
  readonly delegatedPublicKey: RsaPublicKeyParams
}

export interface MachineLicenseInput {
  readonly licenseId: string
  readonly controlLicenseId: string
  readonly projectId: string
  readonly deviceId: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly status: MachineLicenseStatus
  /** 完整的中控证书信封文本，会被内嵌进 payload，使信任链自包含 */
  readonly controlCertificate: string
}

/**
 * 构造中控证书 payload；字段顺序即协议顺序，输出即为被签名字节。
 */
export function buildVendorPayload(input: VendorCertificateInput): {
  payload: VendorControlPayload
  bytes: Buffer
} {
  const payload: VendorControlPayload = {
    schema_version: LICENSE_SCHEMA_VERSION,
    license_type: 'vendor-control',
    license_id: assertLicenseId(input.licenseId, 'license_id'),
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
    project_ids: normalizeProjectIds(input.projectIds),
    max_devices: input.maxDevices,
    delegated_public_key: input.delegatedPublicKey
  }
  validateVendorPayload(payload)
  return { payload, bytes: encodeUtf8(JSON.stringify(payload)) }
}

export function parseVendorPayload(bytes: Uint8Array): VendorControlPayload {
  const parsed = parseStrictJson(decodeUtf8(bytes, 'payload_malformed'), 'payload_malformed')
  validateVendorPayload(parsed)
  return parsed
}

/**
 * 构造子机授权 payload。中控证书以 base64url 内嵌，整条链自包含。
 */
export function buildMachinePayload(input: MachineLicenseInput): {
  payload: MachineLicensePayload
  bytes: Buffer
} {
  const payload: MachineLicensePayload = {
    schema_version: LICENSE_SCHEMA_VERSION,
    license_type: 'machine-license',
    license_id: assertLicenseId(input.licenseId, 'license_id'),
    control_license_id: assertLicenseId(input.controlLicenseId, 'control_license_id'),
    project_id: assertLicenseId(input.projectId, 'project_id'),
    device_id: assertLicenseId(input.deviceId, 'device_id'),
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
    status: input.status,
    control_cert: encodeControlCertificate(input.controlCertificate)
  }
  validateMachinePayload(payload)
  return { payload, bytes: encodeUtf8(JSON.stringify(payload)) }
}

export function parseMachinePayload(bytes: Uint8Array): MachineLicensePayload {
  const parsed = parseStrictJson(decodeUtf8(bytes, 'payload_malformed'), 'payload_malformed')
  validateMachinePayload(parsed)
  return parsed
}

/** 把中控证书信封文本编码为 payload 里的 control_cert 字段 */
export function encodeControlCertificate(envelopeText: string): string {
  if (typeof envelopeText !== 'string' || envelopeText.trim().length === 0) {
    throw new LicenseError('invalid_input', '中控证书内容为空，无法内嵌')
  }
  const bytes = encodeUtf8(envelopeText.trim())
  if (bytes.length > MAX_ENVELOPE_BYTES) {
    throw new LicenseError('invalid_input', '中控证书超过协议上限，无法内嵌')
  }
  return encodeBase64Url(bytes)
}

/** 从 payload 还原中控证书信封文本；不校验签名，调用方必须立刻用厂商公钥验签 */
export function decodeControlCertificate(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LicenseError('payload_invalid', 'control_cert 缺失或不是字符串')
  }
  const bytes = decodeBase64Url(value, 'payload_invalid')
  if (bytes.length === 0) {
    throw new LicenseError('payload_invalid', 'control_cert 为空')
  }
  if (bytes.length > MAX_ENVELOPE_BYTES) {
    throw new LicenseError('payload_invalid', 'control_cert 超过协议上限')
  }
  return decodeUtf8(bytes, 'payload_invalid')
}

export function validateVendorPayload(value: unknown): asserts value is VendorControlPayload {
  const record = assertObjectWithKeys(value, VENDOR_PAYLOAD_KEYS, '中控证书 payload')
  assertSchemaVersion(record['schema_version'])
  assertLicenseTypeField(record['license_type'], 'vendor-control')
  assertLicenseId(record['license_id'], 'license_id')
  assertIssuedBeforeExpires(record['issued_at'], record['expires_at'])
  normalizeProjectIds(record['project_ids'])
  if (
    typeof record['max_devices'] !== 'number' ||
    !Number.isSafeInteger(record['max_devices']) ||
    record['max_devices'] < 1 ||
    record['max_devices'] > 1_000_000
  ) {
    throw new LicenseError('payload_invalid', 'max_devices 必须是 1..1000000 的整数')
  }
  validatePublicKeyParams(record['delegated_public_key'])
}

export function validateMachinePayload(value: unknown): asserts value is MachineLicensePayload {
  const record = assertObjectWithKeys(value, MACHINE_PAYLOAD_KEYS, '子机授权 payload')
  assertSchemaVersion(record['schema_version'])
  assertLicenseTypeField(record['license_type'], 'machine-license')
  assertLicenseId(record['license_id'], 'license_id')
  assertLicenseId(record['control_license_id'], 'control_license_id')
  assertLicenseId(record['project_id'], 'project_id')
  assertLicenseId(record['device_id'], 'device_id')
  assertIssuedBeforeExpires(record['issued_at'], record['expires_at'])
  const status = record['status']
  if (status !== 'active' && status !== 'revoked') {
    throw new LicenseError('payload_invalid', 'status 只能是 active 或 revoked')
  }
  // 只做结构校验：签名有效性由调用方用厂商公钥验证
  decodeControlCertificate(record['control_cert'])
}

/** 时间窗口校验：签发时间不得晚于当前时间过多，过期即拒绝 */
export function assertTimeWindow(
  issuedAt: string,
  expiresAt: string,
  now: number,
  clockSkewMs: number
): void {
  const issued = parseTimestamp(issuedAt)
  const expires = parseTimestamp(expiresAt)
  if (issued > now + clockSkewMs) {
    throw new LicenseError('not_yet_valid', '授权尚未生效')
  }
  if (expires <= now) {
    throw new LicenseError('expired', '授权已过期')
  }
  if (expires > now + 100 * 365 * 24 * 60 * 60 * 1000) {
    throw new LicenseError('payload_invalid', '授权有效期异常')
  }
}

function assertObjectWithKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LicenseError('payload_invalid', `${label} 必须是对象`)
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record)
  const missing = keys.filter((key) => !actual.includes(key))
  const extra = actual.filter((key) => !keys.includes(key))
  if (missing.length > 0 || extra.length > 0) {
    throw new LicenseError('payload_invalid', `${label} 字段集合不匹配（缺少 ${missing.join(',')}；多余 ${extra.join(',')}）`)
  }
  return record
}

function assertSchemaVersion(value: unknown): void {
  if (value !== LICENSE_SCHEMA_VERSION) {
    throw new LicenseError('unsupported_version', `不支持的 schema_version: ${String(value)}`)
  }
}

function assertLicenseTypeField(value: unknown, expected: string): void {
  if (value !== expected) {
    throw new LicenseError('type_mismatch', `license_type 必须为 ${expected}`)
  }
}

function assertIssuedBeforeExpires(issuedAt: unknown, expiresAt: unknown): void {
  if (!isTimestamp(issuedAt) || !isTimestamp(expiresAt)) {
    throw new LicenseError('payload_invalid', 'issued_at / expires_at 时间格式不合法')
  }
  if (parseTimestamp(expiresAt) <= parseTimestamp(issuedAt)) {
    throw new LicenseError('payload_invalid', 'expires_at 必须晚于 issued_at')
  }
}

function normalizeProjectIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LicenseError('payload_invalid', 'project_ids 必须是非空数组')
  }
  const list: string[] = []
  for (const item of value) {
    // "*" 是协议规定的通配项目范围，不属于普通标识符
    if (item !== '*' && !isIdentifier(item)) {
      throw new LicenseError('payload_invalid', 'project_ids 含非法项目 ID')
    }
    list.push(String(item))
  }
  const unique = [...new Set(list)]
  if (unique.length !== list.length) {
    throw new LicenseError('payload_invalid', 'project_ids 不允许重复')
  }
  if (unique.includes('*') && unique.length !== 1) {
    throw new LicenseError('payload_invalid', '"*" 只能单独出现')
  }
  unique.sort()
  return unique
}
