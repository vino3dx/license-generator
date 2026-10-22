import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, type SqliteDatabase } from '@core/db'
import { issueVendorCertificate } from '@core/license/vendor-license'
import { exportPublicKeyParams } from '@core/license/rsa-keys'
import {
  createInMemoryDelegatedKeyStore,
  createLicenseServices,
  FsLicenseFileStore,
  isServiceError,
  type LicenseServices
} from '@core/services'
import { loadTestPrivateKey, loadTestPublicKey, makeVendorInput } from '../fixtures/test-keys'

/**
 * 未配置厂商公钥时（当前开发/交付状态）必须 fail-closed：
 * 项目与审计仍可用，任何需要验证中控证书的操作都必须拒绝，不能静默放行。
 */
const NOW = new Date('2026-10-22T06:00:00Z')
const DELEGATE_PEM = readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'keys', 'delegate-test.private.pem'),
  'utf8'
)

interface Setup {
  readonly database: SqliteDatabase
  readonly services: LicenseServices
  cleanup(): void
}

const cleanups: Array<() => void> = []

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-no-vendor-key-'))
  const { database } = createDatabase(join(dir, 'test.sqlite'))
  const services = createLicenseServices({
    database,
    files: new FsLicenseFileStore(join(dir, 'licenses')),
    delegatedKeys: createInMemoryDelegatedKeyStore(DELEGATE_PEM),
    vendorPublicKey: null,
    clock: () => NOW
  })
  const cleanup = (): void => {
    try {
      database.close()
    } catch {
      // 已关闭
    }
    rmSync(dir, { recursive: true, force: true })
  }
  cleanups.push(cleanup)
  return { database, services, cleanup }
}

function controlEnvelope(): string {
  return issueVendorCertificate(
    makeVendorInput({
      projectIds: ['*'],
      maxDevices: 5,
      delegatedPublicKey: exportPublicKeyParams(loadTestPublicKey('delegate-test'))
    }),
    loadTestPrivateKey('vendor-test')
  ).envelope
}

function expectServiceCode(action: () => unknown, code: string): void {
  try {
    action()
  } catch (error) {
    if (!isServiceError(error)) {
      throw error
    }
    expect(error.code).toBe(code)
    return
  }
  throw new Error(`期望抛出 ${code}，但调用成功返回`)
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

describe('厂商公钥缺失时的 fail-closed 行为', () => {
  it('项目与审计仍可用', () => {
    const { services } = setup()
    const project = services.projects.create({ projectId: 'proj-a', name: '项目 A' })
    expect(project.projectId).toBe('proj-a')
    expect(services.projects.list()).toHaveLength(1)
    expect(services.audit.list().length).toBeGreaterThan(0)
  })

  it('导入中控证书被拒绝', () => {
    const { services } = setup()
    expectServiceCode(() => services.control.importCertificate(controlEnvelope()), 'vendor_key_missing')
  })

  it('登记设备被拒绝（无法确认额度）', () => {
    const { services } = setup()
    services.projects.create({ projectId: 'proj-a', name: '项目 A' })
    expectServiceCode(
      () => services.devices.register({ projectId: 'proj-a', deviceId: 'DEV-0000000000000001' }),
      'vendor_key_missing'
    )
  })

  it('查询当前证书返回 null，而不是伪造一张', () => {
    const { services } = setup()
    expect(services.control.current()).toBeNull()
  })

  it('委托私钥状态可读，但不宣称与证书匹配', () => {
    const { services } = setup()
    const status = services.delegatedKeys.status()
    expect(status.configured).toBe(true)
    expect(status.matchesControl).toBeNull()
  })

  it('签发被拒绝，且不会留下授权记录', () => {
    const { services } = setup()
    services.projects.create({ projectId: 'proj-a', name: '项目 A' })
    expectServiceCode(
      () => services.licensing.issue({ projectId: 'proj-a', deviceId: 'DEV-0000000000000001' }),
      'vendor_key_missing'
    )
    expect(services.licensing.list()).toHaveLength(0)
  })
})
