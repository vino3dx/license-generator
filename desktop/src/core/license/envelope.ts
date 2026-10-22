import { constants, createPublicKey, createSign, createVerify, type KeyObject } from 'node:crypto'
import {
  ENVELOPE_KEYS,
  LICENSE_ENVELOPE_MARKER,
  LICENSE_SCHEMA_VERSION,
  LICENSE_SIGNATURE_ALGORITHM,
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_BYTES,
  RSA_SIGNATURE_BYTES,
  type LicenseEnvelope,
  type LicenseType
} from '@shared/license/protocol'
import { decodeBase64Url, encodeBase64Url } from './encoding'
import { LicenseError } from './errors'
import { computeKeyId, isKeyId } from './rsa-keys'
import { parseStrictJson } from './strict-json'

export interface ParsedEnvelope {
  readonly envelope: LicenseEnvelope
  readonly payloadBytes: Buffer
  readonly signatureBytes: Buffer
}

/**
 * 用私钥对 payload 原始字节签名，返回完整信封 JSON 文本。
 * 签名对象就是传入的字节，函数内部不做任何序列化。
 */
export function createEnvelope(
  payloadBytes: Uint8Array,
  licenseType: LicenseType,
  privateKey: KeyObject
): string {
  if (payloadBytes.length === 0) {
    throw new LicenseError('invalid_input', 'payload 不能为空')
  }
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) {
    throw new LicenseError('payload_too_large', `payload 超过 ${MAX_PAYLOAD_BYTES} 字节`)
  }
  const signature = createSign('RSA-SHA256')
    .update(payloadBytes)
    .sign({ key: privateKey, padding: constants.RSA_PKCS1_PADDING })

  const envelope: LicenseEnvelope = {
    aegis: LICENSE_ENVELOPE_MARKER,
    schema_version: LICENSE_SCHEMA_VERSION,
    license_type: licenseType,
    alg: LICENSE_SIGNATURE_ALGORITHM,
    kid: computeKeyId(privateKey.type === 'private' ? createPublicKey(privateKey) : privateKey),
    payload: encodeBase64Url(payloadBytes),
    signature: encodeBase64Url(signature)
  }
  const text = JSON.stringify(envelope)
  if (Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES) {
    throw new LicenseError('envelope_too_large', '信封超过协议上限')
  }
  return text
}

/**
 * 解析信封并做结构校验（不含签名验证）。
 * 期望类型不匹配、版本不支持、算法不支持、编码非法都在这里拒绝。
 */
export function parseEnvelope(text: string, expectedType: LicenseType): ParsedEnvelope {
  if (typeof text !== 'string' || text.length === 0) {
    throw new LicenseError('invalid_input', '信封内容为空')
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES) {
    throw new LicenseError('envelope_too_large', '信封超过协议上限')
  }

  const parsed = parseStrictJson(text, 'envelope_malformed')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LicenseError('envelope_malformed', '信封必须是 JSON 对象')
  }
  const record = parsed as Record<string, unknown>
  const actualKeys = Object.keys(record)
  if (
    actualKeys.length !== ENVELOPE_KEYS.length ||
    !ENVELOPE_KEYS.every((key) => actualKeys.includes(key))
  ) {
    throw new LicenseError('envelope_malformed', '信封字段集合与协议不一致')
  }
  if (record['aegis'] !== LICENSE_ENVELOPE_MARKER) {
    throw new LicenseError('envelope_malformed', '信封标识不正确')
  }
  if (record['schema_version'] !== LICENSE_SCHEMA_VERSION) {
    throw new LicenseError('unsupported_version', `不支持的信封版本: ${String(record['schema_version'])}`)
  }
  if (record['alg'] !== LICENSE_SIGNATURE_ALGORITHM) {
    throw new LicenseError('unsupported_algorithm', `不支持的签名算法: ${String(record['alg'])}`)
  }
  if (record['license_type'] !== expectedType) {
    throw new LicenseError(
      'type_mismatch',
      `授权类型不匹配：期望 ${expectedType}，实际 ${String(record['license_type'])}`
    )
  }
  const kid = record['kid']
  if (!isKeyId(kid)) {
    throw new LicenseError('envelope_malformed', 'kid 不合法')
  }
  const payloadText = record['payload']
  const signatureText = record['signature']
  if (typeof payloadText !== 'string' || typeof signatureText !== 'string') {
    throw new LicenseError('envelope_malformed', 'payload / signature 必须是字符串')
  }

  const payloadBytes = decodeBase64Url(payloadText, 'base64url_invalid')
  if (payloadBytes.length === 0) {
    throw new LicenseError('envelope_malformed', 'payload 为空')
  }
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) {
    throw new LicenseError('payload_too_large', 'payload 超过协议上限')
  }
  const signatureBytes = decodeBase64Url(signatureText, 'base64url_invalid')
  if (signatureBytes.length !== RSA_SIGNATURE_BYTES) {
    throw new LicenseError(
      'signature_length',
      `签名长度必须为 ${RSA_SIGNATURE_BYTES} 字节，实际 ${signatureBytes.length}`
    )
  }

  return {
    envelope: {
      aegis: LICENSE_ENVELOPE_MARKER,
      schema_version: LICENSE_SCHEMA_VERSION,
      license_type: expectedType,
      alg: LICENSE_SIGNATURE_ALGORITHM,
      kid,
      payload: payloadText,
      signature: signatureText
    },
    payloadBytes,
    signatureBytes
  }
}

/** 对 payload 原始字节验签；失败抛 signature_invalid */
export function verifyEnvelopeSignature(parsed: ParsedEnvelope, publicKey: KeyObject): void {
  assertSignatureInRange(parsed.signatureBytes, publicKey)
  const verifier = createVerify('RSA-SHA256')
  verifier.update(parsed.payloadBytes)
  const ok = verifier.verify(
    { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
    parsed.signatureBytes
  )
  if (!ok) {
    throw new LicenseError('signature_invalid', '签名校验失败')
  }
}

/** 解析 + 验签，一步完成（签名通过前不解析 payload 内容） */
export function openEnvelope(
  text: string,
  expectedType: LicenseType,
  publicKey: KeyObject
): ParsedEnvelope {
  const parsed = parseEnvelope(text, expectedType)
  verifyEnvelopeSignature(parsed, publicKey)
  return parsed
}

function assertSignatureInRange(signatureBytes: Buffer, publicKey: KeyObject): void {
  if (signatureBytes.length !== RSA_SIGNATURE_BYTES) {
    throw new LicenseError('signature_length', '签名长度不合法')
  }
  const jwk = publicKey.export({ format: 'jwk' })
  const modulusHex = jwk.n
  if (typeof modulusHex !== 'string') {
    throw new LicenseError('key_invalid', '无法读取模数')
  }
  const modulus = Buffer.from(modulusHex, 'base64url')
  const signature = BigInt(`0x${signatureBytes.toString('hex')}`)
  const n = BigInt(`0x${modulus.toString('hex')}`)
  if (signature >= n) {
    throw new LicenseError('signature_out_of_range', '签名数值超出模数范围')
  }
}
