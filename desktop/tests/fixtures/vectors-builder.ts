import { createHash, createPublicKey, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeBase64Url } from '@core/license/encoding'
import { createEnvelope } from '@core/license/envelope'
import type { LicenseErrorCode } from '@core/license/errors'
import { issueMachineLicense } from '@core/license/machine-license'
import {
  computeKeyId,
  exportPublicKeyParams,
  loadPrivateKeyFromPem,
  validatePublicKeyParams
} from '@core/license/rsa-keys'
import { issueVendorCertificate } from '@core/license/vendor-license'
import type { LicenseType, RsaPublicKeyParams } from '@shared/license/protocol'

export interface VectorKey {
  readonly kid: string
  readonly public: RsaPublicKeyParams
  /** 供 GDScript 交叉校验 Montgomery 预计算量的诊断信息 */
  readonly montgomery: { readonly n0inv: number; readonly r2_hex: string }
}

export type VectorExpectation = 'ok' | LicenseErrorCode

export interface VectorCase {
  readonly id: string
  readonly note: string
  readonly license_type: LicenseType
  readonly key: 'vendor' | 'delegate' | 'rogue'
  readonly envelope: string
  readonly expect: VectorExpectation
}

export interface VectorsFile {
  readonly protocol: string
  readonly schema_version: number
  readonly note: string
  readonly keys: Record<'vendor' | 'delegate' | 'rogue', VectorKey>
  readonly vendor_certificate: {
    readonly envelope: string
    readonly payload_b64url: string
    readonly payload_sha256_hex: string
    readonly signature_b64url: string
    readonly license_id: string
    readonly expires_at: string
  }
  readonly machine_license: {
    readonly envelope: string
    readonly payload_b64url: string
    readonly payload_sha256_hex: string
    readonly signature_b64url: string
    readonly license_id: string
    readonly expires_at: string
  }
  readonly cases: readonly VectorCase[]
}

const KEY_DIR = join(process.cwd(), 'tests', 'fixtures', 'keys')

function loadKey(name: string): KeyObject {
  return loadPrivateKeyFromPem(readFileSync(join(KEY_DIR, `${name}.private.pem`), 'utf8'))
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function montgomeryDiagnostics(publicKey: RsaPublicKeyParams): { n0inv: number; r2_hex: string } {
  const modulus = BigInt(`0x${Buffer.from(publicKey.n, 'base64url').toString('hex')}`)
  const limb = 1n << 16n
  const n0 = modulus & 0xffffn
  let inverse = 1n
  for (let i = 0; i < 16; i += 1) {
    inverse = (inverse * (2n - ((n0 * inverse) & 0xffffn))) & 0xffffn
  }
  const n0inv = (limb - inverse) & 0xffffn
  const r = 1n << 2048n
  const r2 = (r * r) % modulus
  return { n0inv: Number(n0inv), r2_hex: r2.toString(16).padStart(512, '0') }
}

function toKeyVector(privateKey: KeyObject): VectorKey {
  const publicKey = createPublicKey(privateKey)
  const publicParams = exportPublicKeyParams(publicKey)
  return {
    kid: computeKeyId(publicKey),
    public: publicParams,
    montgomery: montgomeryDiagnostics(publicParams)
  }
}

function envelopeRecord(envelopeText: string): Record<string, string> {
  return JSON.parse(envelopeText) as Record<string, string>
}

function encodeField(bytes: Uint8Array): string {
  return encodeBase64Url(bytes)
}

function decodeField(text: string): Buffer {
  return Buffer.from(text, 'base64url')
}

function flipByteInEnvelope(envelopeText: string, field: 'payload' | 'signature'): string {
  const record = envelopeRecord(envelopeText)
  const current = record[field]
  if (current === undefined) {
    throw new Error(`字段 ${field} 不存在`)
  }
  const bytes = decodeField(current)
  const first = bytes[0]
  if (first === undefined) {
    throw new Error(`字段 ${field} 为空`)
  }
  bytes[0] = first ^ 0x01
  record[field] = encodeField(bytes)
  return JSON.stringify(record)
}

function patchEnvelope(envelopeText: string, patch: Record<string, string>): string {
  return JSON.stringify({ ...(JSON.parse(envelopeText) as Record<string, unknown>), ...patch })
}

export function buildVectors(): VectorsFile {
  const vendorKey = loadKey('vendor-test')
  const delegateKey = loadKey('delegate-test')
  const rogueKey = loadKey('rogue-test')

  const keys = {
    vendor: toKeyVector(vendorKey),
    delegate: toKeyVector(delegateKey),
    rogue: toKeyVector(rogueKey)
  }

  const vendorCert = issueVendorCertificate(
    {
      licenseId: 'VND-TEST-0001',
      issuedAt: '2026-10-01T00:00:00Z',
      expiresAt: '2027-10-01T00:00:00Z',
      projectIds: ['proj-alpha', 'proj-beta'],
      maxDevices: 50,
      delegatedPublicKey: validatePublicKeyParams(keys.delegate.public)
    },
    vendorKey
  )

  const machineLicense = issueMachineLicense(
    {
      licenseId: 'MCH-TEST-0001',
      controlLicenseId: 'VND-TEST-0001',
      projectId: 'proj-alpha',
      deviceId: 'DEV-TEST-0001',
      issuedAt: '2026-10-22T00:00:00Z',
      expiresAt: '2027-01-20T00:00:00Z',
      status: 'active',
      controlCertificate: vendorCert.envelope
    },
    delegateKey
  )

  const vendorRecord = envelopeRecord(vendorCert.envelope)
  const machineRecord = envelopeRecord(machineLicense.envelope)
  const baseVendorPayload = JSON.parse(vendorCert.payloadBytes.toString('utf8')) as Record<string, unknown>

  const truncatedSignature = encodeField(decodeField(vendorRecord['signature'] ?? '').subarray(0, 255))
  const paddedPayload = `${vendorRecord['payload'] ?? ''}=`
  const badCharPayload = `${vendorRecord['payload'] ?? ''}+`

  const cases: VectorCase[] = [
    {
      id: 'vendor-valid',
      note: '厂商签名合法，用厂商公钥验签',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: vendorCert.envelope,
      expect: 'ok'
    },
    {
      id: 'machine-valid',
      note: '委托密钥签名合法，用委托公钥验签',
      license_type: 'machine-license',
      key: 'delegate',
      envelope: machineLicense.envelope,
      expect: 'ok'
    },
    {
      id: 'vendor-payload-byte-flip',
      note: 'payload 被改 1 位',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: flipByteInEnvelope(vendorCert.envelope, 'payload'),
      expect: 'signature_invalid'
    },
    {
      id: 'vendor-signature-byte-flip',
      note: '签名被改 1 位',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: flipByteInEnvelope(vendorCert.envelope, 'signature'),
      expect: 'signature_invalid'
    },
    {
      id: 'vendor-wrong-key',
      note: '用另一把公钥验签',
      license_type: 'vendor-control',
      key: 'rogue',
      envelope: vendorCert.envelope,
      expect: 'signature_invalid'
    },
    {
      id: 'vendor-signed-by-delegate-key',
      note: '厂商证书内容被委托私钥签名',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: createEnvelope(vendorCert.payloadBytes, 'vendor-control', delegateKey),
      expect: 'signature_invalid'
    },
    {
      id: 'vendor-signature-truncated',
      note: '签名被截断 1 字节',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: patchEnvelope(vendorCert.envelope, { signature: truncatedSignature }),
      expect: 'signature_length'
    },
    {
      id: 'vendor-signature-out-of-range',
      note: '签名数值等于模数 n',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: patchEnvelope(vendorCert.envelope, { signature: keys.vendor.public.n }),
      expect: 'signature_out_of_range'
    },
    {
      id: 'vendor-payload-with-padding',
      note: 'payload 带 = 填充',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: patchEnvelope(vendorCert.envelope, { payload: paddedPayload }),
      expect: 'base64url_invalid'
    },
    {
      id: 'vendor-payload-with-plus',
      note: 'payload 含标准 Base64 字符 +',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: patchEnvelope(vendorCert.envelope, { payload: badCharPayload }),
      expect: 'base64url_invalid'
    },
    {
      id: 'vendor-envelope-trailing-garbage',
      note: '信封尾部多一个字符',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: `${vendorCert.envelope}x`,
      expect: 'envelope_malformed'
    },
    {
      id: 'vendor-unsupported-version',
      note: 'schema_version = 2（签名合法）',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: createEnvelope(
        Buffer.from(JSON.stringify({ ...baseVendorPayload, schema_version: 2 }), 'utf8'),
        'vendor-control',
        vendorKey
      ),
      expect: 'unsupported_version'
    },
    {
      id: 'vendor-payload-extra-field',
      note: 'payload 多一个未知字段（签名合法）',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: createEnvelope(
        Buffer.from(JSON.stringify({ ...baseVendorPayload, injected: 'x' }), 'utf8'),
        'vendor-control',
        vendorKey
      ),
      expect: 'payload_invalid'
    },
    {
      id: 'vendor-payload-not-json',
      note: 'payload 不是合法 JSON（签名合法）',
      license_type: 'vendor-control',
      key: 'vendor',
      envelope: createEnvelope(Buffer.from('{"broken":', 'utf8'), 'vendor-control', vendorKey),
      expect: 'payload_malformed'
    },
    {
      id: 'vendor-type-mismatch',
      note: '把子机授权当作中控证书验签',
      license_type: 'vendor-control',
      key: 'delegate',
      envelope: machineLicense.envelope,
      expect: 'type_mismatch'
    },
    {
      id: 'machine-payload-byte-flip',
      note: '子机授权 payload 被改 1 位',
      license_type: 'machine-license',
      key: 'delegate',
      envelope: flipByteInEnvelope(machineLicense.envelope, 'payload'),
      expect: 'signature_invalid'
    },
    {
      id: 'machine-wrong-key',
      note: '用厂商公钥验子机授权',
      license_type: 'machine-license',
      key: 'vendor',
      envelope: machineLicense.envelope,
      expect: 'signature_invalid'
    },
    {
      id: 'machine-signature-byte-flip',
      note: '子机授权签名被改 1 位',
      license_type: 'machine-license',
      key: 'delegate',
      envelope: flipByteInEnvelope(machineLicense.envelope, 'signature'),
      expect: 'signature_invalid'
    }
  ]

  return {
    protocol: 'aegis-license/v1',
    schema_version: 1,
    note: 'TEST ONLY：由 tests/fixtures/keys 中的测试密钥生成，禁止用于生产',
    keys,
    vendor_certificate: {
      envelope: vendorCert.envelope,
      payload_b64url: encodeField(vendorCert.payloadBytes),
      payload_sha256_hex: sha256Hex(vendorCert.payloadBytes),
      signature_b64url: vendorRecord['signature'] ?? '',
      license_id: vendorCert.payload.license_id,
      expires_at: vendorCert.payload.expires_at
    },
    machine_license: {
      envelope: machineLicense.envelope,
      payload_b64url: encodeField(machineLicense.payloadBytes),
      payload_sha256_hex: sha256Hex(machineLicense.payloadBytes),
      signature_b64url: machineRecord['signature'] ?? '',
      license_id: machineLicense.payload.license_id,
      expires_at: machineLicense.payload.expires_at
    },
    cases
  }
}
