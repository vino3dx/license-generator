import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '@core/db'
import { FsLicenseFileStore, isServiceError, type LicenseFileStore } from '@core/services'
import { createHarness, failOnSql } from './harness'

class FailingFileStore extends FsLicenseFileStore {
  private writes = 0

  constructor(
    rootDir: string,
    private readonly failAtWrite: number
  ) {
    super(rootDir)
  }

  override writeAtomic(fileName: string, content: string): void {
    this.writes += 1
    if (this.writes >= this.failAtWrite) {
      throw new Error('模拟磁盘写入失败')
    }
    super.writeAtomic(fileName, content)
  }
}

function prepare(harness: ReturnType<typeof createHarness>, devices: string[]): void {
  harness.services.control.importCertificate(harness.controlEnvelope({ maxDevices: 5 }))
  harness.services.projects.create({ projectId: 'proj-alpha', name: 'Alpha' })
  for (const deviceId of devices) {
    harness.services.devices.register({ projectId: 'proj-alpha', deviceId })
  }
}

describe('授权文件与数据库一致性', () => {
  it('写文件失败时不留下数据库记录与半成品文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-fail-'))
    const harness = createHarness({ files: new FailingFileStore(join(dir, 'licenses'), 1) })
    try {
      prepare(harness, ['dev-1'])
      let caught: unknown
      try {
        harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      } catch (error) {
        caught = error
      }
      expect(isServiceError(caught)).toBe(true)
      expect((caught as { code: string }).code).toBe('license_file_error')
      expect(harness.services.licensing.list()).toHaveLength(0)
      expect(harness.files.list()).toHaveLength(0)
      const audit = harness.services.audit.list({ limit: 50 })
      expect(audit.some((item) => item.errorCode === 'license_file_error')).toBe(true)
    } finally {
      harness.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('批量签发中途写文件失败时回滚已写文件与全部记录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-fail-'))
    const harness = createHarness({ files: new FailingFileStore(join(dir, 'licenses'), 2) })
    try {
      prepare(harness, ['dev-1', 'dev-2'])
      expect(() =>
        harness.services.licensing.issueBatch({ projectId: 'proj-alpha', deviceIds: ['dev-1', 'dev-2'] })
      ).toThrow()
      expect(harness.services.licensing.list()).toHaveLength(0)
      expect(harness.files.list()).toHaveLength(0)
    } finally {
      harness.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('数据库最终提交失败时清理已写文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-dbfail-'))
    const databaseFile = join(dir, 'aegis.sqlite')
    const realDatabase = createDatabase(databaseFile).database
    const proxied = failOnSql(realDatabase, /UPDATE licenses SET file_state/)
    const harness = createHarness({ database: proxied, databaseFile })
    try {
      prepare(harness, ['dev-1'])
      expect(() =>
        harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      ).toThrow()
      expect(harness.services.licensing.list()).toHaveLength(0)
      expect(harness.files.list()).toHaveLength(0)
      const audit = harness.services.audit.list({ limit: 50 })
      expect(audit.some((item) => item.result === 'failure' && item.action === 'license_issue')).toBe(true)
    } finally {
      harness.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('中断恢复：pending 记录与残留文件被回滚', () => {
    const harness = createHarness()
    try {
      prepare(harness, ['dev-1'])
      // 模拟"预留记录后进程被杀"：行已插入、文件也已写入，但状态仍是 pending
      harness.database
        .prepare(
          `INSERT INTO licenses (license_id, project_id, device_id, control_license_id, issued_at, expires_at,
            status, payload_sha256, file_name, file_state, created_at)
           VALUES ('MCH-INTERRUPTED-1', 'proj-alpha', 'dev-1', 'VND-TEST-0001', '2026-10-22T06:00:00Z',
            '2027-01-20T06:00:00Z', 'active', 'deadbeef', 'MCH-INTERRUPTED-1.json', 'pending', '2026-10-22T06:00:00Z')`
        )
        .run()
      harness.files.writeAtomic('MCH-INTERRUPTED-1.json', '{"partial":true}')

      const result = harness.services.maintenance.reconcile()
      expect(result.pendingRolledBack).toBe(1)
      expect(harness.services.licensing.list()).toHaveLength(0)
      expect(harness.files.exists('MCH-INTERRUPTED-1.json')).toBe(false)
      const audit = harness.services.audit.list({ limit: 50 })
      expect(audit.some((item) => item.errorCode === 'interrupted_issuance')).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it('孤儿授权文件被移入隔离目录', () => {
    const harness = createHarness()
    try {
      prepare(harness, ['dev-1'])
      harness.files.writeAtomic('ORPHAN-1.json', '{"not":"recorded"}')
      const result = harness.services.maintenance.reconcile()
      expect(result.orphanFilesQuarantined).toBe(1)
      expect(harness.files.exists('ORPHAN-1.json')).toBe(false)
      const orphanDir = join(harness.files.rootDir, 'orphan')
      expect(existsSync(orphanDir)).toBe(true)
      expect(readdirSync(orphanDir).some((name) => name.endsWith('ORPHAN-1.json'))).toBe(true)
      const audit = harness.services.audit.list({ limit: 50 })
      expect(audit.some((item) => item.errorCode === 'orphan_file')).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it('正常的授权文件不会被恢复流程误删', () => {
    const harness = createHarness()
    try {
      prepare(harness, ['dev-1'])
      const license = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      const result = harness.services.maintenance.reconcile()
      expect(result.pendingRolledBack).toBe(0)
      expect(result.orphanFilesQuarantined).toBe(0)
      expect(harness.files.exists(license.fileName)).toBe(true)
      expect(harness.services.devices.status({ projectId: 'proj-alpha', deviceId: 'dev-1' }).file.ok).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it('授权文件缺失时状态检查给出 file_missing', () => {
    const harness = createHarness()
    try {
      prepare(harness, ['dev-1'])
      const license = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      harness.files.remove(license.fileName)
      const status = harness.services.devices.status({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expect(status.file).toEqual({ ok: false, code: 'file_missing' })
    } finally {
      harness.cleanup()
    }
  })

  it('自定义文件仓库接口便于替换实现', () => {
    const memory = new Map<string, string>()
    const store: LicenseFileStore = {
      rootDir: 'memory',
      writeAtomic: (fileName, content) => {
        memory.set(fileName, content)
      },
      read: (fileName) => memory.get(fileName) ?? '',
      exists: (fileName) => memory.has(fileName),
      remove: (fileName) => {
        memory.delete(fileName)
      },
      list: () => [...memory.keys()],
      quarantine: (fileName) => memory.delete(fileName)
    }
    const harness = createHarness({ files: store })
    try {
      prepare(harness, ['dev-1'])
      const license = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expect(memory.has(license.fileName)).toBe(true)
      expect(harness.services.devices.status({ projectId: 'proj-alpha', deviceId: 'dev-1' }).file.ok).toBe(true)
    } finally {
      harness.cleanup()
    }
  })
})
