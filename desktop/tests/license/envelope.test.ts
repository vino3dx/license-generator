import { describe, expect, it } from 'vitest'
import { encodeBase64Url } from '@core/license/encoding'
import { createEnvelope, openEnvelope, parseEnvelope } from '@core/license/envelope'
import { isLicenseError, type LicenseErrorCode } from '@core/license/errors'
import { buildVendorPayload, type VendorCertificateInput } from '@core/license/payloads'
import { computeKeyId, exportPublicKeyParams } from '@core/license/rsa-keys'
import { issueVendorCertificate } from '@core/license/vendor-license'
import { loadTestPrivateKey, loadTestPublicKey, makeVendorInput } from '../fixtures/test-keys'

const vendorKey = loadTestPrivateKey('vendor-test')
const vendorPublic = loadTestPublicKey('vendor-test')
const roguePublic = loadTestPublicKey('rogue-test')
const delegateKey = loadTestPrivateKey('delegate-test')

function expectCode(action: () => unknown, code: LicenseErrorCode): void {
  try {
    action()
  } catch (error) {
    if (!isLicenseError(error)) {
      throw error
    }
    expect(error.code).toBe(code)
    return
  }
  throw new Error(`期望抛出 ${code}，但调用成功返回`)
}

function issue(input: VendorCertificateInput = makeVendorInput()): string {
  return issueVendorCertificate(input, vendorKey).envelope
}

function patch(envelopeText: string, patchValues: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(envelopeText) as Record<string, unknown>), ...patchValues })
}

describe('信封与 RS256 签名', () => {
  it('签名后可验签，kid 与公钥指纹一致', () => {
    const envelopeText = issue()
    const opened = openEnvelope(envelopeText, 'vendor-control', vendorPublic)
    expect(opened.envelope.kid).toBe(computeKeyId(vendorPublic))
    expect(opened.envelope.alg).toBe('RS256')
    expect(opened.payloadBytes.length).toBeGreaterThan(0)
  })

  it('签名是确定性的（相同 payload + 相同密钥 → 相同字节）', () => {
    const first = issue()
    const second = issue()
    expect(first).toBe(second)
  })

  it('payload 改动 1 位后验签失败', () => {
    const envelopeText = issue()
    const record = JSON.parse(envelopeText) as Record<string, string>
    const payload = Buffer.from(record['payload'] ?? '', 'base64url')
    payload[10] = (payload[10] ?? 0) ^ 0x01
    const tampered = patch(envelopeText, { payload: encodeBase64Url(payload) })
    expectCode(() => openEnvelope(tampered, 'vendor-control', vendorPublic), 'signature_invalid')
  })

  it('签名改动 1 位后验签失败', () => {
    const envelopeText = issue()
    const record = JSON.parse(envelopeText) as Record<string, string>
    const signature = Buffer.from(record['signature'] ?? '', 'base64url')
    signature[5] = (signature[5] ?? 0) ^ 0x01
    const tampered = patch(envelopeText, { signature: encodeBase64Url(signature) })
    expectCode(() => openEnvelope(tampered, 'vendor-control', vendorPublic), 'signature_invalid')
  })

  it('用错误公钥验签失败', () => {
    expectCode(() => openEnvelope(issue(), 'vendor-control', roguePublic), 'signature_invalid')
  })

  it('用委托私钥签的厂商证书验签失败', () => {
    const { bytes } = buildVendorPayload(makeVendorInput())
    const forged = createEnvelope(bytes, 'vendor-control', delegateKey)
    expectCode(() => openEnvelope(forged, 'vendor-control', vendorPublic), 'signature_invalid')
  })

  it('签名长度不是 256 字节被拒绝', () => {
    const envelopeText = issue()
    const signatureText = (JSON.parse(envelopeText) as Record<string, string>)['signature'] ?? ''
    const shortened = Buffer.from(signatureText, 'base64url').subarray(0, 255)
    expectCode(
      () => parseEnvelope(patch(envelopeText, { signature: encodeBase64Url(shortened) }), 'vendor-control'),
      'signature_length'
    )
  })

  it('签名数值不小于模数被拒绝', () => {
    const envelopeText = issue()
    const modulus = exportPublicKeyParams(vendorPublic).n
    expectCode(
      () => openEnvelope(patch(envelopeText, { signature: modulus }), 'vendor-control', vendorPublic),
      'signature_out_of_range'
    )
  })

  it('Base64URL 非法（填充、+ 字符、长度非法）被拒绝', () => {
    const envelopeText = issue()
    const payloadText = (JSON.parse(envelopeText) as Record<string, string>)['payload'] ?? ''
    expectCode(
      () => parseEnvelope(patch(envelopeText, { payload: `${payloadText}=` }), 'vendor-control'),
      'base64url_invalid'
    )
    expectCode(
      () => parseEnvelope(patch(envelopeText, { payload: `${payloadText}+` }), 'vendor-control'),
      'base64url_invalid'
    )
    expectCode(
      () => parseEnvelope(patch(envelopeText, { payload: 'AAAAA' }), 'vendor-control'),
      'base64url_invalid'
    )
  })

  it('信封结构异常被拒绝', () => {
    const envelopeText = issue()
    expectCode(() => parseEnvelope(`${envelopeText}x`, 'vendor-control'), 'envelope_malformed')
    expectCode(() => parseEnvelope('[]', 'vendor-control'), 'envelope_malformed')
    expectCode(() => parseEnvelope('{"aegis":"license-envelope"}', 'vendor-control'), 'envelope_malformed')
    expectCode(
      () => parseEnvelope(patch(envelopeText, { alg: 'RS512' }), 'vendor-control'),
      'unsupported_algorithm'
    )
    expectCode(
      () => parseEnvelope(patch(envelopeText, { schema_version: 2 }), 'vendor-control'),
      'unsupported_version'
    )
    const versionTwo = JSON.stringify({
      ...(JSON.parse(envelopeText) as Record<string, unknown>),
      schema_version: 2
    })
    expectCode(() => parseEnvelope(versionTwo, 'vendor-control'), 'unsupported_version')
  })

  it('授权类型不匹配被拒绝', () => {
    expectCode(() => parseEnvelope(issue(), 'machine-license'), 'type_mismatch')
  })

  it('超出长度上限被拒绝', () => {
    expectCode(() => parseEnvelope('x'.repeat(20 * 1024), 'vendor-control'), 'envelope_too_large')
    const oversizedPayload = Buffer.alloc(9 * 1024, 0x41)
    expectCode(
      () => createEnvelope(oversizedPayload, 'vendor-control', vendorKey),
      'payload_too_large'
    )
  })
})
