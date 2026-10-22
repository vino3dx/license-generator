import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, type SqliteDatabase } from '@core/db'
import { exportPublicKeyParams } from '@core/license/rsa-keys'
import { issueVendorCertificate } from '@core/license/vendor-license'
import {
  createLicenseServices,
  FileDelegatedKeyStore,
  FsLicenseFileStore,
  isServiceError,
  type LicenseServices
} from '@core/services'
import { loadTestPrivateKey, loadTestPublicKey, makeVendorInput } from '../fixtures/test-keys'

const NOW = new Date('2026-10-22T06:00:00Z')
const KEY_DIR = join(process.cwd(), 'tests', 'fixtures', 'keys')
const DELEGATE_PEM = readFileSync(join(KEY_DIR, 'delegate-test.private.pem'), 'utf8')
const ROGUE_PEM = readFileSync(join(KEY_DIR, 'rogue-test.private.pem'), 'utf8')

interface Setup {
  readonly dir: string
  readonly database: SqliteDatabase
  readonly services: LicenseServices
  readonly keyFile: string
  cleanup(): void
}

const cleanups: Array<() => void> = []

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-key-admin-'))
  const { database } = createDatabase(join(dir, 'test.sqlite'))
  const keyFile = join(dir, 'keys', 'delegated.key.pem')
  const services = createLicenseServices({
    database,
    files: new FsLicenseFileStore(join(dir, 'licenses')),
    delegatedKeys: new FileDelegatedKeyStore(keyFile),
    vendorPublicKey: exportPublicKeyParams(loadTestPublicKey('vendor-test')),
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
  return { dir, database, services, keyFile, cleanup }
}

function importControl(services: LicenseServices): void {
  const envelope = issueVendorCertificate(
    makeVendorInput({
      projectIds: ['*'],
      maxDevices: 5,
      delegatedPublicKey: exportPublicKeyParams(loadTestPublicKey('delegate-test'))
    }),
    loadTestPrivateKey('vendor-test')
  ).envelope
  services.control.importCertificate(envelope)
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

describe('委托私钥配置', () => {
  it('未导入时状态为未配置，且不暴露私钥内容', () => {
    const { services, keyFile } = setup()
    const status = services.delegatedKeys.status()
    expect(status.configured).toBe(false)
    expect(status.matchesControl).toBeNull()
    expect(status.location).toBe('keys/delegated.key.pem')
    expect(existsSync(keyFile)).toBe(false)
    expect(JSON.stringify(status)).not.toContain('PRIVATE')
  })

  it('导入合法私钥后落盘，状态变为已配置', () => {
    const { services, keyFile } = setup()
    const status = services.delegatedKeys.import(DELEGATE_PEM)
    expect(status.configured).toBe(true)
    expect(status.matchesControl).toBeNull()
    expect(existsSync(keyFile)).toBe(true)
    expect(readFileSync(keyFile, 'utf8')).toContain('PRIVATE')
  })

  it('导入非法内容时拒绝并记录失败审计', () => {
    const { services } = setup()
    expectServiceCode(() => services.delegatedKeys.import('not a pem'), 'invalid_argument')

    const logs = services.audit.list({ action: 'delegated_key_import' })
    expect(logs).toHaveLength(1)
    expect(logs[0]?.result).toBe('failure')
    expect(logs[0]?.errorCode).toBe('invalid_argument')
    expect(JSON.stringify(logs[0])).not.toContain('PRIVATE')
  })

  it('私钥与已导入的中控证书不匹配时拒绝', () => {
    const { services } = setup()
    importControl(services)
    expectServiceCode(() => services.delegatedKeys.import(ROGUE_PEM), 'delegated_key_mismatch')

    const logs = services.audit.list({ action: 'delegated_key_import' })
    expect(logs[0]?.result).toBe('failure')
    expect(logs[0]?.errorCode).toBe('delegated_key_mismatch')
  })

  it('私钥与中控证书匹配时导入成功并标记 matchesControl', () => {
    const { services } = setup()
    importControl(services)
    const status = services.delegatedKeys.import(DELEGATE_PEM)
    expect(status.configured).toBe(true)
    expect(status.matchesControl).toBe(true)

    const logs = services.audit.list({ action: 'delegated_key_import' })
    expect(logs[0]?.result).toBe('success')
    expect(logs[0]?.targetId).toBe('VND-TEST-0001')
  })

  it('导入后可以正常签发授权（闭环）', () => {
    const { services } = setup()
    importControl(services)
    services.delegatedKeys.import(DELEGATE_PEM)
    services.projects.create({ projectId: 'proj-a', name: '项目 A' })
    services.devices.register({ projectId: 'proj-a', deviceId: 'DEV-0000000000000001' })

    const license = services.licensing.issue({
      projectId: 'proj-a',
      deviceId: 'DEV-0000000000000001'
    })
    expect(license.licenseId.startsWith('MCH-')).toBe(true)
    expect(license.fileName.endsWith('.json')).toBe(true)

    const status = services.devices.status({ projectId: 'proj-a', deviceId: 'DEV-0000000000000001' })
    expect(status.file.ok).toBe(true)
  })
})
