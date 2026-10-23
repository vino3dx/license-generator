import { createPublicKey, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exportPublicKeyParams, loadPrivateKeyFromPem } from '@core/license/rsa-keys'
import { issueVendorCertificate } from '@core/license/vendor-license'
import type { MachineLicenseInput, VendorCertificateInput } from '@core/license/payloads'

export type TestKeyName = 'vendor-test' | 'delegate-test' | 'rogue-test'

export const KEY_DIR = join(process.cwd(), 'tests', 'fixtures', 'keys')

/** 固定"当前时刻"：2026-10-22T06:00:00Z，与测试向量中的时间窗口一致 */
export const NOW = Date.parse('2026-10-22T06:00:00Z')

export function loadTestPrivateKey(name: TestKeyName): KeyObject {
  return loadPrivateKeyFromPem(readFileSync(join(KEY_DIR, `${name}.private.pem`), 'utf8'))
}

export function loadTestPublicKey(name: TestKeyName): KeyObject {
  return createPublicKey(loadTestPrivateKey(name))
}

export function makeVendorInput(overrides: Partial<VendorCertificateInput> = {}): VendorCertificateInput {
  return {
    licenseId: 'VND-TEST-0001',
    issuedAt: '2026-10-01T00:00:00Z',
    expiresAt: '2027-10-01T00:00:00Z',
    projectIds: ['proj-alpha', 'proj-beta'],
    maxDevices: 50,
    delegatedPublicKey: requireDelegatePublicParams(),
    ...overrides
  }
}

export function makeMachineInput(overrides: Partial<MachineLicenseInput> = {}): MachineLicenseInput {
  return {
    licenseId: 'MCH-TEST-0001',
    controlLicenseId: 'VND-TEST-0001',
    projectId: 'proj-alpha',
    deviceId: 'DEV-TEST-0001',
    issuedAt: '2026-10-22T00:00:00Z',
    expiresAt: '2027-01-20T00:00:00Z',
    status: 'active',
    // 协议 v3：payload 必须内嵌中控证书；默认用 makeVendorInput 的默认证书（与 chain.test 一致）
    controlCertificate: issueVendorCertificate(makeVendorInput(), loadTestPrivateKey('vendor-test')).envelope,
    ...overrides
  }
}

function requireDelegatePublicParams(): VendorCertificateInput['delegatedPublicKey'] {
  return exportPublicKeyParams(loadTestPublicKey('delegate-test'))
}
