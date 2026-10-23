import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import {
  PUBLIC_KEY_KEYS,
  RSA_MAX_EXPONENT_UPPER_BOUND,
  RSA_MIN_EXPONENT,
  RSA_MODULUS_BYTES,
  type RsaPublicKeyParams
} from '@shared/license/protocol'
import { encodeBase64Url, decodeBase64Url, isIdentifier } from './encoding'
import { LicenseError } from './errors'

/**
 * 协议内公钥只以 {kty,n,e} 表达；这里负责与 Node KeyObject 互转，
 * 并在两个方向上执行同一套强度校验（与 GDScript 验签器保持一致）。
 */

export function loadPrivateKeyFromPem(pem: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey({ key: pem, format: 'pem' })
  } catch {
    throw new LicenseError('key_invalid', '私钥 PEM 无法解析')
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa') {
    throw new LicenseError('key_invalid', '需要 RSA 私钥')
  }
  assertPrivateKeyStrength(key)
  return key
}

export function derivePublicKey(privateKey: KeyObject): KeyObject {
  return createPublicKey(privateKey)
}

/** 生成协议强度要求的 RSA-2048 私钥（厂商根密钥与委托私钥共用，固定 e=65537） */
export function generateRsaPrivateKey(): KeyObject {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: RSA_MODULUS_BYTES * 8,
    publicExponent: 0x10001
  })
  assertPrivateKeyStrength(privateKey)
  return privateKey
}

/** 导出 PKCS#1 PEM 文本，供落盘保存与 P1 中控导入 */
export function exportPrivateKeyPem(privateKey: KeyObject): string {
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
}

export function exportPublicKeyParams(publicKey: KeyObject): RsaPublicKeyParams {
  const jwk = publicKey.export({ format: 'jwk' })
  const n = jwk.n
  const e = jwk.e
  if (typeof n !== 'string' || typeof e !== 'string') {
    throw new LicenseError('key_invalid', '无法导出 RSA 公钥参数')
  }
  return validatePublicKeyParams({ kty: 'RSA', n, e })
}

/** 结构 + 强度校验，不创建 KeyObject；用于校验证书里携带的委托公钥 */
export function validatePublicKeyParams(value: unknown): RsaPublicKeyParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LicenseError('key_invalid', '公钥必须是对象')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== PUBLIC_KEY_KEYS.length || !PUBLIC_KEY_KEYS.every((key) => keys.includes(key))) {
    throw new LicenseError('key_invalid', '公钥字段必须且只能是 kty/n/e')
  }
  if (record['kty'] !== 'RSA') {
    throw new LicenseError('key_invalid', '公钥 kty 必须为 RSA')
  }
  const n = record['n']
  const e = record['e']
  if (typeof n !== 'string' || typeof e !== 'string') {
    throw new LicenseError('key_invalid', '公钥 n/e 必须是 base64url 字符串')
  }

  const modulus = decodeBase64Url(n, 'key_invalid')
  if (modulus.length !== RSA_MODULUS_BYTES) {
    throw new LicenseError('key_invalid', `模数必须为 ${RSA_MODULUS_BYTES} 字节`)
  }
  const firstByte = modulus[0]
  const lastByte = modulus[RSA_MODULUS_BYTES - 1]
  if (firstByte === undefined || firstByte < 0x80) {
    throw new LicenseError('key_invalid', '模数不是 2048 位')
  }
  if (lastByte === undefined || lastByte % 2 === 0) {
    throw new LicenseError('key_invalid', '模数不是奇数')
  }

  const exponentBytes = decodeBase64Url(e, 'key_invalid')
  if (exponentBytes.length < 1 || exponentBytes.length > 4) {
    throw new LicenseError('key_invalid', '公钥指数长度不合法')
  }
  let exponent = 0
  for (const byte of exponentBytes) {
    exponent = exponent * 256 + byte
  }
  if (exponent % 2 === 0 || exponent < RSA_MIN_EXPONENT || exponent >= RSA_MAX_EXPONENT_UPPER_BOUND) {
    throw new LicenseError('key_invalid', '公钥指数不合法')
  }
  const canonicalExponent = encodeBase64Url(exponentBytes)

  return { kty: 'RSA', n: encodeBase64Url(modulus), e: canonicalExponent }
}

export function importPublicKeyParams(params: RsaPublicKeyParams): KeyObject {
  const validated = validatePublicKeyParams(params)
  let key: KeyObject
  try {
    key = createPublicKey({ key: { kty: 'RSA', n: validated.n, e: validated.e }, format: 'jwk' })
  } catch {
    throw new LicenseError('key_invalid', '公钥无法导入')
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa') {
    throw new LicenseError('key_invalid', '导入结果不是 RSA 公钥')
  }
  return key
}

/** kid = base64url(sha256(SPKI DER))，用于选键与审计 */
export function computeKeyId(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return encodeBase64Url(createHash('sha256').update(der).digest())
}

export function isKeyId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  try {
    return decodeBase64Url(value, 'key_invalid').length === 32
  } catch {
    return false
  }
}

export function assertLicenseId(value: unknown, field: string): string {
  if (!isIdentifier(value)) {
    throw new LicenseError('payload_invalid', `${field} 不合法`)
  }
  return value
}

function assertPrivateKeyStrength(key: KeyObject): void {
  const details = key.asymmetricKeyDetails
  if (details?.modulusLength !== RSA_MODULUS_BYTES * 8) {
    throw new LicenseError('key_invalid', `RSA 密钥长度必须为 ${RSA_MODULUS_BYTES * 8} 位`)
  }
  const exponent = details.publicExponent
  if (exponent === undefined) {
    throw new LicenseError('key_invalid', '无法读取公钥指数')
  }
  if (exponent % 2n === 0n || exponent < BigInt(RSA_MIN_EXPONENT) || exponent >= BigInt(RSA_MAX_EXPONENT_UPPER_BOUND)) {
    throw new LicenseError('key_invalid', '公钥指数不合法')
  }
}
