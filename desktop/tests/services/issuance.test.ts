import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isServiceError } from '@core/services'
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
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
      const payload = Buffer.from(record['payload'] ?? '', 'base64url')
      payload[20] = (payload[20] ?? 0) ^ 0x01
      record['payload'] = payload.toString('base64url')
      writeFileSync(path, JSON.stringify(record), 'utf8')

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
      const renewed = harness.services.licensing.renew({
        projectId: 'proj-alpha',
        deviceId: 'dev-1',
        expiresAt: '2027-08-01T00:00:00Z'
      })
      expect(renewed.licenseId).not.toBe(first.licenseId)
      expect(harness.services.control.quota().usedDevices).toBe(1)

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
