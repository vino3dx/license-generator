import { describe, expect, it } from 'vitest'
import { isLicenseError, type LicenseErrorCode } from '@core/license/errors'
import { issueMachineLicense, verifyMachineLicense } from '@core/license/machine-license'
import { computeKeyId, exportPublicKeyParams } from '@core/license/rsa-keys'
import {
  isProjectAllowed,
  issueVendorCertificate,
  verifyVendorCertificate
} from '@core/license/vendor-license'
import {
  NOW,
  loadTestPrivateKey,
  loadTestPublicKey,
  makeMachineInput,
  makeVendorInput
} from '../fixtures/test-keys'

const vendorKey = loadTestPrivateKey('vendor-test')
const delegateKey = loadTestPrivateKey('delegate-test')
const vendorPublic = loadTestPublicKey('vendor-test')
const roguePublic = loadTestPublicKey('rogue-test')

const EXPECTED = { projectId: 'proj-alpha', deviceId: 'DEV-TEST-0001' } as const

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

function issueCertificate(overrides: Parameters<typeof makeVendorInput>[0] = {}): string {
  return issueVendorCertificate(makeVendorInput(overrides), vendorKey).envelope
}

describe('第一层：厂商中控授权证书', () => {
  it('验签通过并取出委托公钥', () => {
    const certificate = verifyVendorCertificate(issueCertificate(), vendorPublic, NOW)
    expect(certificate.licenseId).toBe('VND-TEST-0001')
    expect(certificate.payload.max_devices).toBe(50)
    expect(certificate.delegatedKeyId).toBe(computeKeyId(loadTestPublicKey('delegate-test')))
    expect(certificate.expiresAt).toBe(Date.parse('2027-10-01T00:00:00Z'))
  })

  it('过期证书被拒绝', () => {
    const certificate = issueCertificate()
    expectCode(
      () => verifyVendorCertificate(certificate, vendorPublic, Date.parse('2027-10-02T00:00:00Z')),
      'expired'
    )
  })

  it('尚未生效的证书被拒绝', () => {
    expectCode(
      () => verifyVendorCertificate(issueCertificate(), vendorPublic, Date.parse('2026-09-01T00:00:00Z')),
      'not_yet_valid'
    )
  })

  it('项目范围支持通配 *', () => {
    const certificate = verifyVendorCertificate(issueCertificate({ projectIds: ['*'] }), vendorPublic, NOW)
    expect(isProjectAllowed(certificate, 'anything')).toBe(true)
  })

  it('非白名单项目不可用', () => {
    const certificate = verifyVendorCertificate(issueCertificate(), vendorPublic, NOW)
    expect(isProjectAllowed(certificate, 'proj-alpha')).toBe(true)
    expect(isProjectAllowed(certificate, 'proj-gamma')).toBe(false)
  })
})

describe('第二层：子机授权', () => {
  it('完整链路验签通过', () => {
    const certificate = verifyVendorCertificate(issueCertificate(), vendorPublic, NOW)
    const license = issueMachineLicense(makeMachineInput(), delegateKey)
    const verified = verifyMachineLicense(license.envelope, certificate, EXPECTED, NOW)
    expect(verified.licenseId).toBe('MCH-TEST-0001')
    expect(verified.payload.device_id).toBe('DEV-TEST-0001')
  })

  it('归属其他中控证书时拒绝', () => {
    const certificate = verifyVendorCertificate(issueCertificate(), vendorPublic, NOW)
    const license = issueMachineLicense(makeMachineInput({ controlLicenseId: 'VND-OTHER-9999' }), delegateKey)
    expectCode(() => verifyMachineLicense(license.envelope, certificate, EXPECTED, NOW), 'control_license_mismatch')
  })

  it('状态非 active 时拒绝', () => {
    const certificate = verifyVendorCertificate(issueCertificate(), vendorPublic, NOW)
    const license = issueMachineLicense(makeMachineInput({ status: 'revoked' }), delegateKey)
    expectCode(() => verifyMachineLicense(license.envelope, certificate, EXPECTED, NOW), 'status_inactive')
  })

  it('设备不匹配时拒绝', () => {
    const certificate = verifyVendorCertificate(issueCertificate(), vendorPublic, NOW)
    const license = issueMachineLicense(makeMachineInput(), delegateKey)
    expectCode(
      () => verifyMachineLicense(license.envelope, certificate, { ...EXPECTED, deviceId: 'DEV-OTHER' }, NOW),
      'device_mismatch'
    )
  })

  it('项目不在中控授权范围内时拒绝', () => {
    const certificate = verifyVendorCertificate(issueCertificate(), vendorPublic, NOW)
    const license = issueMachineLicense(makeMachineInput({ projectId: 'proj-gamma' }), delegateKey)
    expectCode(() => verifyMachineLicense(license.envelope, certificate, { ...EXPECTED, projectId: 'proj-gamma' }, NOW), 'project_not_allowed')
  })

  it('子机授权有效期不得超过中控证书', () => {
    const certificate = verifyVendorCertificate(
      issueCertificate({ expiresAt: '2026-12-01T00:00:00Z' }),
      vendorPublic,
      NOW
    )
    const license = issueMachineLicense(makeMachineInput({ expiresAt: '2027-01-20T00:00:00Z' }), delegateKey)
    expectCode(() => verifyMachineLicense(license.envelope, certificate, EXPECTED, NOW), 'payload_invalid')
  })

  it('中控证书过期后子机授权同样被拒绝', () => {
    const certificate = verifyVendorCertificate(issueCertificate(), vendorPublic, NOW)
    const license = issueMachineLicense(makeMachineInput(), delegateKey)
    expectCode(
      () => verifyMachineLicense(license.envelope, certificate, EXPECTED, Date.parse('2027-10-02T00:00:00Z')),
      'expired'
    )
  })

  it('子机授权过期时拒绝', () => {
    const certificate = verifyVendorCertificate(issueCertificate(), vendorPublic, NOW)
    const license = issueMachineLicense(makeMachineInput({ expiresAt: '2026-11-01T00:00:00Z' }), delegateKey)
    expectCode(
      () => verifyMachineLicense(license.envelope, certificate, EXPECTED, Date.parse('2026-11-02T00:00:00Z')),
      'expired'
    )
  })

  it('证书里换成攻击者公钥后，合法委托签名不再通过', () => {
    const forgedCertificate = verifyVendorCertificate(
      issueCertificate({ delegatedPublicKey: exportPublicKeyParams(roguePublic) }),
      vendorPublic,
      NOW
    )
    const license = issueMachineLicense(makeMachineInput(), delegateKey)
    expectCode(() => verifyMachineLicense(license.envelope, forgedCertificate, EXPECTED, NOW), 'signature_invalid')
  })
})
