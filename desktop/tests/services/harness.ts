import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KeyObject } from 'node:crypto'
import { createDatabase, type SqliteDatabase } from '@core/db'
import {
  createInMemoryDelegatedKeyStore,
  createLicenseServices,
  FsLicenseFileStore,
  type DelegatedKeyStore,
  type LicenseFileStore,
  type LicenseServices
} from '@core/services'
import { exportPublicKeyParams } from '@core/license/rsa-keys'
import type { VendorCertificateInput } from '@core/license/payloads'
import type { RsaPublicKeyParams } from '@shared/license/protocol'
import { issueVendorCertificate } from '@core/license/vendor-license'
import { loadTestPrivateKey, loadTestPublicKey, makeVendorInput } from '../fixtures/test-keys'

export const FIXED_NOW = new Date('2026-10-22T06:00:00Z')

export interface Harness {
  readonly dir: string
  readonly databaseFile: string
  readonly database: SqliteDatabase
  readonly services: LicenseServices
  readonly files: LicenseFileStore
  readonly vendorKey: KeyObject
  readonly delegateKey: KeyObject
  /** 厂商测试公钥参数（用于在同一数据库上重建服务实例，例如模拟重启） */
  readonly vendorPublicParams: RsaPublicKeyParams
  /** 本机委托私钥存储（内存实现，仅供测试重建服务） */
  readonly delegatedKeys: DelegatedKeyStore
  /** 用厂商测试私钥签一张中控证书（只用于测试） */
  controlEnvelope(overrides?: Partial<VendorCertificateInput>): string
  cleanup(): void
}

export interface HarnessOptions {
  readonly clock?: () => Date
  readonly files?: LicenseFileStore
  readonly database?: SqliteDatabase
  readonly databaseFile?: string
  /** 覆盖本机委托私钥 PEM，用于不匹配测试 */
  readonly delegatePem?: string
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-test-'))
  const databaseFile = options.databaseFile ?? join(dir, 'test.sqlite')
  const database = options.database ?? createDatabase(databaseFile).database
  const files = options.files ?? new FsLicenseFileStore(join(dir, 'licenses'))
  const vendorKey = loadTestPrivateKey('vendor-test')
  const delegateKey = loadTestPrivateKey('delegate-test')
  const delegatePublic = exportPublicKeyParams(loadTestPublicKey('delegate-test'))
  const vendorPublicParams = exportPublicKeyParams(loadTestPublicKey('vendor-test'))
  const delegatedKeys = createInMemoryDelegatedKeyStore(
    options.delegatePem ??
      readFileSync(join(process.cwd(), 'tests', 'fixtures', 'keys', 'delegate-test.private.pem'), 'utf8')
  )

  const services = createLicenseServices({
    database,
    files,
    delegatedKeys,
    vendorPublicKey: vendorPublicParams,
    clock: options.clock ?? (() => FIXED_NOW)
  })

  return {
    dir,
    databaseFile,
    database,
    services,
    files,
    vendorKey,
    delegateKey,
    vendorPublicParams,
    delegatedKeys,
    controlEnvelope: (overrides = {}) =>
      issueVendorCertificate(
        // 默认不限项目，需要验证项目范围时由用例显式覆盖 projectIds
        makeVendorInput({ delegatedPublicKey: delegatePublic, projectIds: ['*'], maxDevices: 3, ...overrides }),
        vendorKey
      ).envelope,
    cleanup: () => {
      try {
        database.close()
      } catch {
        // 已关闭
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export function withServices<T>(work: (harness: Harness) => T, options: HarnessOptions = {}): T {
  const harness = createHarness(options)
  try {
    return work(harness)
  } finally {
    harness.cleanup()
  }
}

/** 让指定 SQL 在 prepare 阶段抛错，用于模拟数据库事务失败 */
export function failOnSql(database: SqliteDatabase, pattern: RegExp, message = '模拟数据库失败'): SqliteDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (pattern.test(sql)) {
            throw new Error(message)
          }
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    }
  }) as SqliteDatabase
}
