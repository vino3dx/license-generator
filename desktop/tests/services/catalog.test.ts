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

describe('项目', () => {
  it('创建、查询与重复创建约束', () => {
    const harness = createHarness()
    try {
      const project = harness.services.projects.create({ projectId: 'proj-a', name: '项目 A' })
      expect(project.status).toBe('active')
      expect(harness.services.projects.list()).toHaveLength(1)
      expectServiceError(() => harness.services.projects.create({ projectId: 'proj-a', name: '重复' }), 'conflict')
      expectServiceError(() => harness.services.projects.create({ projectId: '../etc', name: 'x' }), 'invalid_argument')
      expectServiceError(() => harness.services.projects.create({ projectId: 'p2', name: '   ' }), 'invalid_argument')
    } finally {
      harness.cleanup()
    }
  })
})

describe('设备登记与额度', () => {
  it('未导入中控证书时不能登记设备，并记录失败审计', () => {
    const harness = createHarness()
    try {
      harness.services.projects.create({ projectId: 'proj-a', name: '项目 A' })
      expectServiceError(
        () => harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-1' }),
        'control_certificate_missing'
      )
    } finally {
      harness.cleanup()
    }
  })

  it('重复登记幂等，不重复占用额度', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      harness.services.projects.create({ projectId: 'proj-a', name: '项目 A' })

      const first = harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-1' })
      const second = harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-1' })

      expect(second.registeredAt).toBe(first.registeredAt)
      expect(harness.services.devices.list()).toHaveLength(1)
      expect(harness.services.control.quota().usedDevices).toBe(1)
    } finally {
      harness.cleanup()
    }
  })

  it('达到额度上限后拒绝登记', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope({ maxDevices: 3 }))
      harness.services.projects.create({ projectId: 'proj-a', name: '项目 A' })
      for (const id of ['dev-1', 'dev-2', 'dev-3']) {
        harness.services.devices.register({ projectId: 'proj-a', deviceId: id })
      }
      expect(harness.services.control.quota()).toEqual({
        controlLicenseId: 'VND-TEST-0001',
        maxDevices: 3,
        usedDevices: 3
      })
      expectServiceError(
        () => harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-4' }),
        'device_quota_exceeded'
      )

      const audit = harness.services.audit.list({ limit: 20 })
      const failure = audit.find((item) => item.action === 'device_register' && item.result === 'failure')
      expect(failure?.errorCode).toBe('device_quota_exceeded')
      expect((failure?.actor ?? '').length).toBeGreaterThan(0)
    } finally {
      harness.cleanup()
    }
  })

  it('锁定设备继续占用额度，解绑后释放', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope({ maxDevices: 2 }))
      harness.services.projects.create({ projectId: 'proj-a', name: '项目 A' })
      harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-1' })
      harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-2' })

      const locked = harness.services.devices.lock({ projectId: 'proj-a', deviceId: 'dev-1', reason: '欠费停机' })
      expect(locked.locked).toBe(true)
      expect(harness.services.control.quota().usedDevices).toBe(2)
      expectServiceError(
        () => harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-3' }),
        'device_quota_exceeded'
      )

      harness.services.devices.unbind({ projectId: 'proj-a', deviceId: 'dev-2', reason: '客户退货' })
      expect(harness.services.control.quota().usedDevices).toBe(1)
      expect(() => harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-3' })).not.toThrow()

      const audit = harness.services.audit.list({ limit: 50 })
      const actions = audit.map((item) => item.action)
      expect(actions).toContain('device_lock')
      expect(actions).toContain('device_unbind')
      const unbind = audit.find((item) => item.action === 'device_unbind')
      expect(unbind?.context).toContain('客户退货')
    } finally {
      harness.cleanup()
    }
  })

  it('解绑后可重新登记同一设备', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope({ maxDevices: 1 }))
      harness.services.projects.create({ projectId: 'proj-a', name: '项目 A' })
      harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-1' })
      harness.services.devices.unbind({ projectId: 'proj-a', deviceId: 'dev-1', reason: '换机' })
      const again = harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-1' })
      expect(again.unbindAt).toBeNull()
      expect(harness.services.control.quota().usedDevices).toBe(1)
    } finally {
      harness.cleanup()
    }
  })

  it('解绑必须给出原因，且重复解绑被拒绝', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      harness.services.projects.create({ projectId: 'proj-a', name: '项目 A' })
      harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-1' })
      expectServiceError(
        () => harness.services.devices.unbind({ projectId: 'proj-a', deviceId: 'dev-1', reason: '' }),
        'invalid_argument'
      )
      harness.services.devices.unbind({ projectId: 'proj-a', deviceId: 'dev-1', reason: '退货' })
      expectServiceError(
        () => harness.services.devices.unbind({ projectId: 'proj-a', deviceId: 'dev-1', reason: '退货' }),
        'not_found'
      )
    } finally {
      harness.cleanup()
    }
  })

  it('未签发授权时设备状态为 no_license', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      harness.services.projects.create({ projectId: 'proj-a', name: '项目 A' })
      harness.services.devices.register({ projectId: 'proj-a', deviceId: 'dev-1' })
      const status = harness.services.devices.status({ projectId: 'proj-a', deviceId: 'dev-1' })
      expect(status.license).toBeNull()
      expect(status.file).toEqual({ ok: false, code: 'no_license' })
    } finally {
      harness.cleanup()
    }
  })
})
