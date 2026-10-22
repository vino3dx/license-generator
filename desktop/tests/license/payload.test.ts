import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isLicenseError, type LicenseErrorCode } from '@core/license/errors'
import {
  buildMachinePayload,
  buildVendorPayload,
  parseMachinePayload,
  parseVendorPayload,
  validateVendorPayload
} from '@core/license/payloads'
import { exportPublicKeyParams } from '@core/license/rsa-keys'
import { parseStrictJson } from '@core/license/strict-json'
import { makeMachineInput, makeVendorInput } from '../fixtures/test-keys'

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

function bytesOf(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

describe('payload 规范化', () => {
  it('中控证书字段顺序与协议一致', () => {
    const { bytes } = buildVendorPayload(makeVendorInput())
    const text = bytes.toString('utf8')
    expect(text.startsWith('{"schema_version":1,"license_type":"vendor-control","license_id":"VND-TEST-0001"')).toBe(true)
    expect(text).toContain('"issued_at":"2026-10-01T00:00:00Z"')
    expect(text.indexOf('"delegated_public_key"')).toBeGreaterThan(text.indexOf('"features"'))
  })

  it('子机授权字段顺序与协议一致', () => {
    const { bytes } = buildMachinePayload(makeMachineInput())
    const text = bytes.toString('utf8')
    expect(
      text.startsWith(
        '{"schema_version":1,"license_type":"machine-license","license_id":"MCH-TEST-0001","control_license_id":"VND-TEST-0001"'
      )
    ).toBe(true)
  })

  it('project_ids 会被排序，* 只能单独出现', () => {
    const { payload } = buildVendorPayload(makeVendorInput({ projectIds: ['proj-beta', 'proj-alpha'] }))
    expect(payload.project_ids).toEqual(['proj-alpha', 'proj-beta'])
    expectCode(
      () => buildVendorPayload(makeVendorInput({ projectIds: ['*', 'proj-alpha'] })),
      'payload_invalid'
    )
    expectCode(() => buildVendorPayload(makeVendorInput({ projectIds: [] })), 'payload_invalid')
    expectCode(
      () => buildVendorPayload(makeVendorInput({ projectIds: ['proj-alpha', 'proj-alpha'] })),
      'payload_invalid'
    )
  })

  it('时间、额度、标识符非法时拒绝', () => {
    expectCode(() => buildVendorPayload(makeVendorInput({ issuedAt: '2026-10-01 00:00:00' })), 'payload_invalid')
    expectCode(
      () => buildVendorPayload(makeVendorInput({ expiresAt: '2026-10-01T00:00:00Z', issuedAt: '2026-10-01T00:00:00Z' })),
      'payload_invalid'
    )
    expectCode(() => buildVendorPayload(makeVendorInput({ maxDevices: 0 })), 'payload_invalid')
    expectCode(() => buildVendorPayload(makeVendorInput({ maxDevices: 1_000_001 })), 'payload_invalid')
    expectCode(() => buildVendorPayload(makeVendorInput({ licenseId: 'bad id' })), 'payload_invalid')
    expectCode(() => buildVendorPayload(makeVendorInput({ features: ['ok', 'ok'] })), 'payload_invalid')
  })

  it('委托公钥强度不足时拒绝', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 })
    expectCode(
      () =>
        buildVendorPayload(
          makeVendorInput({
            delegatedPublicKey: exportPublicKeyParams(weak.publicKey)
          })
        ),
      'key_invalid'
    )
    const strong = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const params = exportPublicKeyParams(strong.publicKey)
    expectCode(
      () => buildVendorPayload(makeVendorInput({ delegatedPublicKey: { ...params, kty: 'EC' as 'RSA' } })),
      'key_invalid'
    )
    // 指数 3 低于协议下限
    expectCode(
      () => buildVendorPayload(makeVendorInput({ delegatedPublicKey: { ...params, e: 'Aw' } })),
      'key_invalid'
    )
    // 模数少一个字节（不是 2048 位）
    expectCode(
      () => buildVendorPayload(makeVendorInput({ delegatedPublicKey: { ...params, n: params.n.slice(2) } })),
      'key_invalid'
    )
  })

  it('解析时拒绝未知字段、缺失字段与未知版本', () => {
    const { payload } = buildVendorPayload(makeVendorInput())
    expectCode(() => parseVendorPayload(bytesOf({ ...payload, extra: 1 })), 'payload_invalid')
    const { max_devices: _removed, ...missing } = payload
    expectCode(() => parseVendorPayload(bytesOf(missing)), 'payload_invalid')
    expectCode(() => parseVendorPayload(bytesOf({ ...payload, schema_version: 2 })), 'unsupported_version')
    expectCode(() => parseVendorPayload(bytesOf({ ...payload, license_type: 'machine-license' })), 'type_mismatch')
  })

  it('validateVendorPayload 可直接用于对象校验', () => {
    const { payload } = buildVendorPayload(makeVendorInput())
    expect(() => validateVendorPayload(payload)).not.toThrow()
    expectCode(() => validateVendorPayload({ ...payload, max_devices: 2.5 }), 'payload_invalid')
  })

  it('子机授权状态枚举受限', () => {
    expectCode(() => buildMachinePayload(makeMachineInput({ status: 'paused' as 'active' })), 'payload_invalid')
    const { bytes } = buildMachinePayload(makeMachineInput({ status: 'revoked' }))
    expect(parseMachinePayload(bytes).status).toBe('revoked')
  })
})

describe('严格 JSON 解析', () => {
  it('拒绝重复键', () => {
    expectCode(() => parseStrictJson('{"a":1,"a":2}', 'payload_malformed'), 'payload_malformed')
  })

  it('拒绝非整数、前导零与超范围数字', () => {
    expectCode(() => parseStrictJson('{"a":1.5}', 'payload_malformed'), 'payload_malformed')
    expectCode(() => parseStrictJson('{"a":01}', 'payload_malformed'), 'payload_malformed')
    expectCode(() => parseStrictJson('{"a":-1}', 'payload_malformed'), 'payload_malformed')
    expectCode(() => parseStrictJson('{"a":9007199254740993}', 'payload_malformed'), 'payload_malformed')
  })

  it('拒绝尾部垃圾、裸控制字符与未知转义', () => {
    expectCode(() => parseStrictJson('{"a":1} trailing', 'payload_malformed'), 'payload_malformed')
    expectCode(() => parseStrictJson('{"a":"\u0001"}', 'payload_malformed'), 'payload_malformed')
    expectCode(() => parseStrictJson('{"a":"\\x41"}', 'payload_malformed'), 'payload_malformed')
    expectCode(() => parseStrictJson('{"a":}', 'payload_malformed'), 'payload_malformed')
    expectCode(() => parseStrictJson('', 'payload_malformed'), 'payload_malformed')
  })

  it('正常 JSON 仍可解析', () => {
    const parsed = parseStrictJson('{"a":[1,2,{"b":"c"}],"d":true,"e":null}', 'payload_malformed') as Record<string, unknown>
    expect(Array.isArray(parsed['a'])).toBe(true)
    expect(parsed['d']).toBe(true)
    expect(parsed['e']).toBeNull()
  })
})
