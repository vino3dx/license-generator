import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDatabase, countBoundDevices, type SqliteDatabase } from '@core/db'
import { parseLicenseContainer } from '@core/license/container'
import { parseEnvelope } from '@core/license/envelope'
import { decodeControlCertificate, parseMachinePayload } from '@core/license/payloads'
import { FsLicenseFileStore, isServiceError } from '@core/services'
import { createHarness } from './harness'

function expectServiceError(action: () => unknown, code: string): void {
  try {
    action()
  } catch (error) {
    expect(isServiceError(error)).toBe(true)
    expect((error as { code: string }).code).toBe(code)
    return
  }
  throw new Error(`期望抛出 ${code}，但调用成功`)
}

function captureServiceError(action: () => unknown): Record<string, unknown> {
  try {
    action()
  } catch (error) {
    expect(isServiceError(error)).toBe(true)
    return error as unknown as Record<string, unknown>
  }
  throw new Error('期望抛出 ServiceError，但调用成功')
}

function activeControlEnvelope(harness: ReturnType<typeof createHarness>): string {
  const row = harness.database
    .prepare('SELECT envelope FROM control_certificates ORDER BY imported_at DESC, rowid DESC LIMIT 1')
    .get() as { envelope: string }
  return row.envelope
}

function prepare(harness: ReturnType<typeof createHarness>, devices = ['dev-1'], maxDevices = 3): void {
  harness.services.control.importCertificate(harness.controlEnvelope({ maxDevices }))
  harness.services.projects.create({ projectId: 'proj-alpha', name: '项目 Alpha' })
  for (const deviceId of devices) {
    harness.services.devices.register({ projectId: 'proj-alpha', deviceId })
  }
}

describe('签发', () => {
  it('签发成功后写入数据库与授权文件，且文件可通过验签', () => {
    const harness = createHarness()
    try {
      prepare(harness)
      const license = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })

      expect(license.status).toBe('active')
      expect(license.fileState).toBe('written')
      expect(license.controlLicenseId).toBe('VND-TEST-0001')
      expect(license.expiresAt).toBe('2027-01-20T06:00:00Z')
      expect(harness.files.exists(license.fileName)).toBe(true)

      // 约定 v3.1 §2：文件是容器，内嵌当前 control.cert；payload 内嵌同一份证书
      const controlEnvelope = activeControlEnvelope(harness)
      const container = parseLicenseContainer(
        new TextEncoder().encode(readFileSync(join(harness.files.rootDir, license.fileName), 'utf8'))
      )
      expect(container.control).toBe(controlEnvelope)
      const opened = parseEnvelope(container.license, 'machine-license')
      expect(decodeControlCertificate(parseMachinePayload(opened.payloadBytes).control_cert)).toBe(controlEnvelope)

      const status = harness.services.devices.status({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expect(status.license?.licenseId).toBe(license.licenseId)
      expect(status.file).toEqual({ ok: true, code: null })

      const audit = harness.services.audit.list({ action: 'license_issue' })
      expect(audit.some((item) => item.result === 'success' && item.targetId === license.licenseId)).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it('授权文件被篡改时状态检查失败，不依赖数据库 status', () => {
    const harness = createHarness()
    try {
      prepare(harness)
      const license = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      const path = join(harness.files.rootDir, license.fileName)
      // 篡改容器内层信封的 payload，容器结构本身保持合法
      const container = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
      const envelope = JSON.parse(container['license'] ?? '') as Record<string, string>
      const payload = Buffer.from(envelope['payload'] ?? '', 'base64url')
      payload[20] = (payload[20] ?? 0) ^ 0x01
      envelope['payload'] = payload.toString('base64url')
      container['license'] = JSON.stringify(envelope)
      writeFileSync(path, JSON.stringify(container), 'utf8')

      const status = harness.services.devices.status({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expect(status.license?.status).toBe('active')
      expect(status.file.ok).toBe(false)
      expect(status.file.code).toBe('signature_invalid')
    } finally {
      harness.cleanup()
    }
  })

  it('指定到期时间不得超过中控证书', () => {
    const harness = createHarness()
    try {
      prepare(harness)
      expectServiceError(
        () =>
          harness.services.licensing.issue({
            projectId: 'proj-alpha',
            deviceId: 'dev-1',
            expiresAt: '2027-12-01T00:00:00Z'
          }),
        'license_expiry_invalid'
      )
      // 约定 v3.1：超限报错必须带上中控证书的上限日期
      const overLimit = captureServiceError(() =>
        harness.services.licensing.issue({
          projectId: 'proj-alpha',
          deviceId: 'dev-1',
          expiresAt: '2027-12-01T00:00:00Z'
        })
      )
      expect(overLimit['code']).toBe('license_expiry_invalid')
      expect(String(overLimit['message'])).toContain('2027-10-01T00:00:00Z')
      expect((overLimit['details'] as Record<string, unknown>)['maxExpiresAt']).toBe('2027-10-01T00:00:00Z')
      expectServiceError(
        () =>
          harness.services.licensing.issue({
            projectId: 'proj-alpha',
            deviceId: 'dev-1',
            expiresAt: '2026-01-01T00:00:00Z'
          }),
        'license_expiry_invalid'
      )
      const ok = harness.services.licensing.issue({
        projectId: 'proj-alpha',
        deviceId: 'dev-1',
        expiresAt: '2027-06-01T00:00:00Z'
      })
      expect(ok.expiresAt).toBe('2027-06-01T00:00:00Z')
    } finally {
      harness.cleanup()
    }
  })

  it('项目不在中控授权范围内时拒绝签发', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope({ projectIds: ['proj-alpha'] }))
      harness.services.projects.create({ projectId: 'proj-alpha', name: 'Alpha' })
      harness.services.projects.create({ projectId: 'proj-gamma', name: 'Gamma' })
      // proj-gamma 不在范围内，登记设备时就会被拒
      expectServiceError(
        () => harness.services.devices.register({ projectId: 'proj-gamma', deviceId: 'dev-9' }),
        'project_not_in_scope'
      )
      harness.services.devices.register({ projectId: 'proj-alpha', deviceId: 'dev-1' })

      // 直接调用服务层（绕过界面）同样被拒绝
      expectServiceError(
        () => harness.services.licensing.issue({ projectId: 'proj-gamma', deviceId: 'dev-1' }),
        'project_not_in_scope'
      )
      const audit = harness.services.audit.list({ limit: 50 })
      expect(audit.some((item) => item.errorCode === 'project_not_in_scope')).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it('无中控证书时拒绝签发', () => {
    const harness = createHarness()
    try {
      harness.services.projects.create({ projectId: 'proj-alpha', name: 'Alpha' })
      expectServiceError(
        () => harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' }),
        'control_certificate_missing'
      )
    } finally {
      harness.cleanup()
    }
  })

  it('证书过期后拒绝签发', () => {
    let now = new Date('2026-10-22T06:00:00Z')
    const harness = createHarness({ clock: () => now })
    try {
      prepare(harness)
      now = new Date('2027-10-02T00:00:00Z')
      expectServiceError(
        () => harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' }),
        'control_certificate_expired'
      )
    } finally {
      harness.cleanup()
    }
  })

  it('数据库中证书被篡改后拒绝签发（每次签发都重新验签）', () => {
    const harness = createHarness()
    try {
      prepare(harness)
      const row = harness.database
        .prepare('SELECT envelope FROM control_certificates WHERE is_active = 1')
        .get() as { envelope: string }
      const record = JSON.parse(row.envelope) as Record<string, string>
      const payload = Buffer.from(record['payload'] ?? '', 'base64url')
      payload[30] = (payload[30] ?? 0) ^ 0x01
      record['payload'] = payload.toString('base64url')
      harness.database
        .prepare('UPDATE control_certificates SET envelope = ? WHERE is_active = 1')
        .run(JSON.stringify(record))

      expectServiceError(
        () => harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' }),
        'control_certificate_invalid'
      )
      expect(harness.services.licensing.list()).toHaveLength(0)
    } finally {
      harness.cleanup()
    }
  })

  it('本机委托私钥与证书不匹配时拒绝签发', () => {
    const roguePem = readFileSync(
      join(process.cwd(), 'tests', 'fixtures', 'keys', 'rogue-test.private.pem'),
      'utf8'
    )
    const harness = createHarness({ delegatePem: roguePem })
    try {
      prepare(harness)
      expectServiceError(
        () => harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' }),
        'delegated_key_mismatch'
      )
      expect(harness.services.licensing.list()).toHaveLength(0)
    } finally {
      harness.cleanup()
    }
  })

  it('续期生成新授权并替代旧授权，不额外占用额度', () => {
    const harness = createHarness()
    try {
      prepare(harness)
      const first = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      // 证书可重复使用：续期不需要重新导入证书
      const renewed = harness.services.licensing.renew({
        projectId: 'proj-alpha',
        deviceId: 'dev-1',
        expiresAt: '2027-08-01T00:00:00Z'
      })
      expect(renewed.licenseId).not.toBe(first.licenseId)
      expect(harness.services.control.current()?.licenseId).toBe('VND-TEST-0001')
      // 续期不额外占用额度
      expect(countBoundDevices(harness.database, null)).toBe(1)

      const licenses = harness.services.licensing.list({ deviceId: 'dev-1' })
      const previous = licenses.find((item) => item.licenseId === first.licenseId)
      expect(previous?.supersededBy).toBe(renewed.licenseId)

      const status = harness.services.devices.status({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expect(status.license?.licenseId).toBe(renewed.licenseId)
      expect(status.file.ok).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it('续期前必须存在可续期授权', () => {
    const harness = createHarness()
    try {
      prepare(harness)
      expectServiceError(
        () => harness.services.licensing.renew({ projectId: 'proj-alpha', deviceId: 'dev-1' }),
        'not_found'
      )
    } finally {
      harness.cleanup()
    }
  })
})

describe('证书可重复使用（同一张有效证书多次签发/续期）', () => {
  it('同一张证书可连续签发两次，旧授权被替代但证书仍生效', () => {
    const harness = createHarness()
    try {
      prepare(harness)
      const first = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expect(harness.services.control.current()?.licenseId).toBe('VND-TEST-0001')

      const second = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expect(second.licenseId).not.toBe(first.licenseId)
      // 证书仍可用（不再被消费）
      expect(harness.services.control.current()?.licenseId).toBe('VND-TEST-0001')
      const row = harness.database
        .prepare('SELECT is_active FROM control_certificates WHERE license_id = ?')
        .get('VND-TEST-0001') as { is_active: number }
      expect(row.is_active).toBe(1)

      // 替代关系仍然正确
      const previous = harness.services.licensing
        .list({ deviceId: 'dev-1' })
        .find((item) => item.licenseId === first.licenseId)
      expect(previous?.supersededBy).toBe(second.licenseId)

      const status = harness.services.devices.status({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expect(status.license?.licenseId).toBe(second.licenseId)
      expect(status.file).toEqual({ ok: true, code: null })

      // 不再产生"证书作废"审计
      expect(harness.services.audit.list({ action: 'control_certificate_consume' })).toHaveLength(0)
    } finally {
      harness.cleanup()
    }
  })

  it('同一张证书可为已有授权设备续期，无需重新导入证书', () => {
    const harness = createHarness()
    try {
      prepare(harness)
      const first = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      const renewed = harness.services.licensing.renew({
        projectId: 'proj-alpha',
        deviceId: 'dev-1',
        expiresAt: '2027-08-01T00:00:00Z'
      })
      expect(renewed.expiresAt).toBe('2027-08-01T00:00:00Z')
      expect(harness.services.control.current()?.licenseId).toBe('VND-TEST-0001')
      const previous = harness.services.licensing
        .list({ deviceId: 'dev-1' })
        .find((item) => item.licenseId === first.licenseId)
      expect(previous?.supersededBy).toBe(renewed.licenseId)
      expect(harness.services.devices.status({ projectId: 'proj-alpha', deviceId: 'dev-1' }).file.ok).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it('批量签发成功后证书仍可用，且额度不重复占用', () => {
    const harness = createHarness()
    try {
      prepare(harness, ['dev-1', 'dev-2'], 5)
      const result = harness.services.licensing.issueBatch({
        projectId: 'proj-alpha',
        deviceIds: ['dev-1', 'dev-2']
      })
      expect(result.issued).toHaveLength(2)
      expect(harness.services.control.current()?.licenseId).toBe('VND-TEST-0001')
      expect(countBoundDevices(harness.database, null)).toBe(2)

      // 之后还能继续签发第三台
      harness.services.devices.register({ projectId: 'proj-alpha', deviceId: 'dev-3' })
      const third = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-3' })
      expect(third.status).toBe('active')
    } finally {
      harness.cleanup()
    }
  })

  it('签发失败后证书仍可用', () => {
    const harness = createHarness()
    try {
      prepare(harness, ['dev-1'], 5)
      expectServiceError(
        () =>
          harness.services.licensing.issueBatch({
            projectId: 'proj-alpha',
            deviceIds: ['dev-1', 'dev-missing']
          }),
        'not_found'
      )
      expect(harness.services.control.current()?.licenseId).toBe('VND-TEST-0001')
      const ok = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expect(ok.status).toBe('active')
    } finally {
      harness.cleanup()
    }
  })

  it('写文件失败时旧授权保持有效，不产生新记录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-writefail-'))
    class FailFromSecondWrite extends FsLicenseFileStore {
      private writes = 0

      override writeAtomic(fileName: string, content: string): void {
        this.writes += 1
        if (this.writes >= 2) {
          throw new Error('模拟磁盘写入失败')
        }
        super.writeAtomic(fileName, content)
      }
    }
    const harness = createHarness({ files: new FailFromSecondWrite(join(dir, 'licenses')) })
    try {
      prepare(harness)
      const first = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expectServiceError(
        () =>
          harness.services.licensing.renew({
            projectId: 'proj-alpha',
            deviceId: 'dev-1',
            expiresAt: '2027-09-01T00:00:00Z'
          }),
        'license_file_error'
      )

      // 旧授权未被破坏：仍是当前授权、文件可验、没有新增记录或文件
      const status = harness.services.devices.status({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expect(status.license?.licenseId).toBe(first.licenseId)
      expect(status.file).toEqual({ ok: true, code: null })
      expect(harness.services.licensing.list({ deviceId: 'dev-1' })).toHaveLength(1)
      expect(harness.files.list()).toHaveLength(1)
      expect(harness.services.control.current()?.licenseId).toBe('VND-TEST-0001')
    } finally {
      harness.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('最终事务失败时清理新授权，旧授权与证书状态不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-commitfail-'))
    const databaseFile = join(dir, 'aegis.sqlite')
    const realDatabase = createDatabase(databaseFile).database
    let failCommit = false
    // 只让"标记 written"这条 SQL 失败，模拟文件已落盘但最终事务提交失败
    const guarded = new Proxy(realDatabase, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (failCommit && /UPDATE licenses SET file_state/.test(sql)) {
              throw new Error('模拟最终事务失败')
            }
            return target.prepare(sql)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      }
    }) as SqliteDatabase
    const harness = createHarness({ database: guarded, databaseFile })
    try {
      prepare(harness)
      const first = harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      failCommit = true
      expect(() =>
        harness.services.licensing.renew({
          projectId: 'proj-alpha',
          deviceId: 'dev-1',
          expiresAt: '2027-09-01T00:00:00Z'
        })
      ).toThrow('模拟最终事务失败')
      failCommit = false

      const status = harness.services.devices.status({ projectId: 'proj-alpha', deviceId: 'dev-1' })
      expect(status.license?.licenseId).toBe(first.licenseId)
      expect(status.file).toEqual({ ok: true, code: null })
      expect(harness.services.licensing.list({ deviceId: 'dev-1' })).toHaveLength(1)
      expect(harness.files.list()).toHaveLength(1)
      expect(harness.services.control.current()?.licenseId).toBe('VND-TEST-0001')
    } finally {
      harness.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('批量签发', () => {
  it('同一项目多台设备批量签发全部成功', () => {
    const harness = createHarness()
    try {
      prepare(harness, ['dev-1', 'dev-2', 'dev-3'], 5)
      const result = harness.services.licensing.issueBatch({
        projectId: 'proj-alpha',
        deviceIds: ['dev-1', 'dev-2', 'dev-3']
      })
      expect(result.issued).toHaveLength(3)
      expect(harness.files.list()).toHaveLength(3)
      for (const deviceId of ['dev-1', 'dev-2', 'dev-3']) {
        expect(harness.services.devices.status({ projectId: 'proj-alpha', deviceId }).file.ok).toBe(true)
      }
    } finally {
      harness.cleanup()
    }
  })

  it('任一设备不满足条件时整批回滚（全批成功策略）', () => {
    const harness = createHarness()
    try {
      prepare(harness, ['dev-1'], 5)
      expectServiceError(
        () =>
          harness.services.licensing.issueBatch({
            projectId: 'proj-alpha',
            deviceIds: ['dev-1', 'dev-missing']
          }),
        'not_found'
      )
      expect(harness.services.licensing.list()).toHaveLength(0)
      expect(harness.files.list()).toHaveLength(0)
      const audit = harness.services.audit.list({ limit: 50 })
      expect(audit.some((item) => item.result === 'failure' && item.targetId === 'dev-missing')).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it('导入更小额度证书后，签发被额度拦截', () => {
    const harness = createHarness()
    try {
      prepare(harness, ['dev-1', 'dev-2'], 5)
      // 换成只允许 1 台设备的证书（模拟厂商缩容）
      harness.services.control.importCertificate(
        harness.controlEnvelope({ licenseId: 'VND-TEST-0002', maxDevices: 1 })
      )
      expectServiceError(
        () => harness.services.licensing.issue({ projectId: 'proj-alpha', deviceId: 'dev-1' }),
        'device_quota_exceeded'
      )
      expect(harness.services.licensing.list()).toHaveLength(0)
    } finally {
      harness.cleanup()
    }
  })

  it('批量签发会去重设备，不产生重复授权记录', () => {
    const harness = createHarness()
    try {
      prepare(harness, ['dev-1', 'dev-2'], 5)
      const result = harness.services.licensing.issueBatch({
        projectId: 'proj-alpha',
        deviceIds: ['dev-1', 'dev-1', 'dev-2']
      })
      expect(result.issued).toHaveLength(2)
      expect(harness.files.list()).toHaveLength(2)
    } finally {
      harness.cleanup()
    }
  })
})
