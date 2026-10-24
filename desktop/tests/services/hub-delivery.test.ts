import { describe, expect, it } from 'vitest'
import { listDeliveryOrders, listLicenses } from '@core/db'
import { parseLicenseContainer } from '@core/license/container'
import { importPublicKeyParams } from '@core/license/rsa-keys'
import { verifyMachineLicense } from '@core/license/machine-license'
import { verifyVendorCertificate } from '@core/license/vendor-license'
import { createHarness, FIXED_NOW, type Harness } from './harness'

/** 直接落库登记设备：本用例关注 Hub 决策，不重复测试登记接口的范围校验 */
function devicesIn(harness: Harness, projectId = 'proj-a', deviceId = 'dev-1'): void {
  harness.database
    .prepare("INSERT OR IGNORE INTO projects (project_id, name, status, created_at) VALUES (?, ?, 'active', ?)")
    .run(projectId, projectId, '2026-10-22T06:00:00Z')
  harness.database
    .prepare('INSERT INTO devices (project_id, device_id, registered_at) VALUES (?, ?, ?)')
    .run(projectId, deviceId, '2026-10-22T06:00:00Z')
}

function pull(deviceId = 'dev-1', projectId = 'proj-a', extra: { currentLicenseId?: string; allow?: boolean } = {}) {
  return {
    deviceId,
    projectId,
    currentLicenseId: extra.currentLicenseId ?? '',
    lastExpiresAt: null,
    ip: '127.0.0.1',
    allowIncompatibleSchema: extra.allow ?? false
  }
}

describe('Hub 拉取决策', () => {
  it('未登记设备被拒绝，且不产生授权文件', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      const outcome = harness.services.hub.handlePull(pull('dev-unknown'))
      expect(outcome.status).toBe('denied')
      expect(outcome.reason).toBe('device_not_registered')
      expect(harness.files.list()).toEqual([])
    } finally {
      harness.cleanup()
    }
  })

  it('设备与工程不匹配时拒绝（请求里的 project_id 不可信）', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      devicesIn(harness)
      const outcome = harness.services.hub.handlePull(pull('dev-1', 'proj-other'))
      expect(outcome.status).toBe('denied')
      expect(outcome.reason).toBe('device_project_mismatch')
    } finally {
      harness.cleanup()
    }
  })

  it('没有生效中控证书时拒绝', () => {
    const harness = createHarness()
    try {
      devicesIn(harness)
      const outcome = harness.services.hub.handlePull(pull())
      expect(outcome.status).toBe('denied')
      expect(outcome.reason).toBe('control_certificate_missing')
    } finally {
      harness.cleanup()
    }
  })

  it('项目不在证书范围时拒绝', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope({ projectIds: ['proj-b'] }))
      devicesIn(harness)
      const outcome = harness.services.hub.handlePull(pull('dev-1', 'proj-a'))
      expect(outcome.status).toBe('denied')
      expect(outcome.reason).toBe('project_not_in_scope')
    } finally {
      harness.cleanup()
    }
  })

  it('已登记设备数超过证书额度时拒绝下发', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope({ projectIds: ['*'], maxDevices: 5 }))
      devicesIn(harness, 'proj-a', 'dev-1')
      devicesIn(harness, 'proj-a', 'dev-2')
      // 换一张更小的证书：已登记 2 台 > 1
      harness.services.control.importCertificate(harness.controlEnvelope({ projectIds: ['*'], maxDevices: 1 }))
      const outcome = harness.services.hub.handlePull(pull('dev-1'))
      expect(outcome.status).toBe('denied')
      expect(outcome.reason).toBe('device_quota_exceeded')
    } finally {
      harness.cleanup()
    }
  })

  it('默认（协议不兼容）拒绝下发并说明原因，不把未下发写成已发送', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      devicesIn(harness)
      const outcome = harness.services.hub.handlePull(pull())
      expect(outcome.status).toBe('denied')
      expect(outcome.reason).toBe('license_schema_mismatch')
      expect(outcome.license).toBe('')
      expect(harness.files.list()).toEqual([])
      expect(listDeliveryOrders(harness.database)).toEqual([])
    } finally {
      harness.cleanup()
    }
  })
})

describe('Hub 下发（中控侧可独立验证的部分）', () => {
  it('生成的容器能通过 desktop 自身的 v3 全链校验（厂商证书 → 委托签名 → 设备绑定）', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      devicesIn(harness)
      const outcome = harness.services.hub.handlePull(pull('dev-1', 'proj-a', { allow: true }))
      expect(outcome.status).toBe('issued')
      expect(outcome.orderId).not.toBeNull()

      const container = parseLicenseContainer(new TextEncoder().encode(outcome.license))
      const vendorPublic = importPublicKeyParams(harness.vendorPublicParams)
      const certificate = verifyVendorCertificate(container.control, vendorPublic, FIXED_NOW.getTime())
      const verified = verifyMachineLicense(
        container.license,
        certificate,
        { projectId: 'proj-a', deviceId: 'dev-1' },
        FIXED_NOW.getTime()
      )
      expect(verified.payload.device_id).toBe('dev-1')
      expect(verified.payload.project_id).toBe('proj-a')
      expect(verified.payload.status).toBe('active')
      expect(Date.parse(verified.payload.expires_at)).toBeLessThanOrEqual(certificate.expiresAt)
    } finally {
      harness.cleanup()
    }
  })

  it('下发成功后订单为 sent（不是 confirmed），并记录通信留证', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      devicesIn(harness)
      const outcome = harness.services.hub.handlePull(pull('dev-1', 'proj-a', { allow: true }))
      expect(outcome.status).toBe('issued')

      const orders = listDeliveryOrders(harness.database)
      expect(orders).toHaveLength(1)
      expect(orders[0]?.state).toBe('sent')
      expect(orders[0]?.sentAt).not.toBeNull()
      expect(orders[0]?.confirmedAt).toBeNull()

      const requests = harness.services.hub.listRequests({ limit: 10 })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.result).toBe('issued')
      expect(requests[0]?.orderId).toBe(outcome.orderId)
    } finally {
      harness.cleanup()
    }
  })

  it('重复拉取复用同一订单与授权文件，不重复签发', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      devicesIn(harness)
      const first = harness.services.hub.handlePull(pull('dev-1', 'proj-a', { allow: true }))
      const second = harness.services.hub.handlePull(pull('dev-1', 'proj-a', { allow: true }))
      expect(first.status).toBe('issued')
      expect(second.status).toBe('issued')
      expect(second.orderId).toBe(first.orderId)
      expect(second.reason).toBe('reused_order')
      expect(listDeliveryOrders(harness.database)).toHaveLength(1)
      expect(listLicenses(harness.database, { deviceId: 'dev-1' })).toHaveLength(1)
    } finally {
      harness.cleanup()
    }
  })

  it('子机自报持有该授权后，订单升级为 confirmed，并在后续请求返回 unchanged', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      devicesIn(harness)
      const first = harness.services.hub.handlePull(pull('dev-1', 'proj-a', { allow: true }))
      const licenseId = listDeliveryOrders(harness.database)[0]?.licenseId
      expect(licenseId).toBeDefined()

      const second = harness.services.hub.handlePull(
        pull('dev-1', 'proj-a', { currentLicenseId: licenseId as string, allow: true })
      )
      expect(second.status).toBe('unchanged')
      expect(second.reason).toBe('already_current')

      const orders = listDeliveryOrders(harness.database)
      expect(orders[0]?.state).toBe('confirmed')
      expect(orders[0]?.confirmedAt).not.toBeNull()

      // 确认依据必须留痕，且标明是客户端自报而不是密码学证明
      const audit = harness.database
        .prepare("SELECT context FROM audit_logs WHERE action = 'delivery_confirmed'")
        .all() as { context: string | null }[]
      expect(audit.length).toBe(1)
      expect(audit[0]?.context).toContain('client_self_report')
      expect(first.orderId).toBe(orders[0]?.orderId)
    } finally {
      harness.cleanup()
    }
  })

  it('子机自报的未知授权 ID 不会被当成确认依据', () => {
    const harness = createHarness()
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      devicesIn(harness)
      const first = harness.services.hub.handlePull(pull('dev-1', 'proj-a', { allow: true }))
      const second = harness.services.hub.handlePull(
        pull('dev-1', 'proj-a', { currentLicenseId: 'MCH-FORGED-0000', allow: true })
      )
      expect(second.status).toBe('issued')
      const orders = listDeliveryOrders(harness.database)
      // 伪造 ID 不会让订单变成 confirmed；仍复用同一条 sent 订单
      expect(orders[0]?.state).toBe('sent')
      expect(second.orderId).toBe(first.orderId)
      expect(harness.database.prepare("SELECT COUNT(1) AS n FROM audit_logs WHERE action = 'delivery_confirmed'").get())
        .toEqual({ n: 0 })
    } finally {
      harness.cleanup()
    }
  })
})
