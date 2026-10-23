// @vitest-environment jsdom
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceDto, IpcResult } from '@shared/license/service-contract'
import IssueView from '@renderer/views/IssueView.vue'
import { localInputToUtc } from '@renderer/lib/format'

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

const project = {
  projectId: 'proj-a',
  name: '项目 A',
  status: 'active',
  createdAt: '2026-10-22T06:00:00Z'
} as const

const device = {
  projectId: 'proj-a',
  deviceId: 'DEV-1a2b3c4d5e6f7788',
  registeredAt: '2026-10-22T06:00:00Z',
  locked: false,
  lockedAt: null,
  unbindAt: null
} as const

const deviceB = {
  projectId: 'proj-a',
  deviceId: 'DEV-9a8b7c6d5e4f3210',
  registeredAt: '2026-10-22T06:00:00Z',
  locked: false,
  lockedAt: null,
  unbindAt: null
} as const

let deviceList: DeviceDto[] = [device]

const certificate = {
  licenseId: 'VND-TEST-0001',
  kid: 'kid',
  issuedAt: '2026-10-01T00:00:00Z',
  expiresAt: '2027-10-01T00:00:00Z',
  importedAt: '2026-10-22T06:00:00Z',
  isActive: true,
  projectIds: ['proj-a'],
  maxDevices: 10,
  features: ['license.issue']
} as const

const license = {
  licenseId: 'MCH-20261022060000-ABCDEF',
  projectId: 'proj-a',
  deviceId: 'DEV-1a2b3c4d5e6f7788',
  controlLicenseId: 'VND-TEST-0001',
  issuedAt: '2026-10-22T06:00:00Z',
  expiresAt: '2027-01-20T06:00:00Z',
  status: 'active',
  payloadSha256: 'hash',
  fileName: 'MCH-20261022060000-ABCDEF.json',
  fileState: 'written',
  supersededBy: null
} as const

let vendorConfigured = true
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  vendorConfigured = true
  deviceList = [device]
  api = {
    listProjects: vi.fn(async () => ok([project])),
    currentControlCertificate: vi.fn(async () => ok(certificate)),
    quota: vi.fn(async () => ok({ controlLicenseId: 'VND-TEST-0001', maxDevices: 10, usedDevices: 1 })),
    vendorKeyStatus: vi.fn(async () => ok({ configured: vendorConfigured })),
    delegatedKeyStatus: vi.fn(async () =>
      ok({ configured: true, matchesControl: true, location: 'keys/delegated.key.pem' })
    ),
    listDevices: vi.fn(async () => ok(deviceList)),
    issueLicense: vi.fn(async () => ok(license)),
    issueLicensesBatch: vi.fn(async () => ok({ issued: [license] })),
    renewLicense: vi.fn(async () => ok(license)),
    importControlCertificate: vi.fn(async () => ok(certificate)),
    pickControlCertificateFile: vi.fn(async () => ok(null)),
    importDelegatedKey: vi.fn(async () =>
      ok({ configured: true, matchesControl: true, location: 'keys/delegated.key.pem' })
    )
  }
  Object.defineProperty(window, 'aegis', {
    value: {
      license: api,
      getAppInfo: vi.fn(async () => ({
        appName: 'aegis',
        appVersion: '0.1.0',
        isPackaged: false,
        platform: 'win32',
        electronVersion: '45.0.0',
        chromeVersion: '1',
        nodeVersion: '22',
        userDataPath: 'C:/aegis-data'
      }))
    },
    configurable: true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function findIssueButton(wrapper: VueWrapper): DOMWrapper<Element> | undefined {
  return wrapper.findAll('button').find((button) => button.text().includes('签发授权'))
}

describe('授权签发页面', () => {
  it('未配置厂商公钥时阻断签发并说明原因', async () => {
    vendorConfigured = false
    const wrapper = mount(IssueView)
    await flushPromises()

    expect(wrapper.text()).toContain('未配置厂商公钥，无法验证中控证书，也不能签发')
    const button = findIssueButton(wrapper)
    expect(button).toBeDefined()
    expect(button?.attributes('disabled')).toBeDefined()
  })

  it('配置齐全时选中设备可以签发，并显示授权文件位置', async () => {
    const wrapper = mount(IssueView)
    await flushPromises()

    const checkbox = wrapper.findAll('input[type="checkbox"]')[0]
    expect(checkbox).toBeDefined()
    await checkbox!.setValue(true)
    await flushPromises()

    const button = findIssueButton(wrapper)
    expect(button?.attributes('disabled')).toBeUndefined()
    await button!.trigger('click')
    await flushPromises()

    expect(api['issueLicense']).toHaveBeenCalledWith({
      projectId: 'proj-a',
      deviceId: device.deviceId
    })
    expect(wrapper.text()).toContain(license.licenseId)
    expect(wrapper.text()).toContain('C:/aegis-data/licenses/MCH-20261022060000-ABCDEF.json')
  })

  it('未选择设备时不会调用签发服务', async () => {
    const wrapper = mount(IssueView)
    await flushPromises()

    const button = findIssueButton(wrapper)
    expect(button?.attributes('disabled')).toBeDefined()
    expect(api['issueLicense']).not.toHaveBeenCalled()
  })

  it('多台设备走批量签发，并携带自定义到期时间', async () => {
    deviceList = [device, deviceB]
    const wrapper = mount(IssueView)
    await flushPromises()

    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    expect(checkboxes.length).toBe(2)
    await checkboxes[0]!.setValue(true)
    await checkboxes[1]!.setValue(true)
    await wrapper.find('input[type="datetime-local"]').setValue('2026-11-11T08:00')

    const button = wrapper
      .findAll('button')
      .find((button) => button.text().includes('批量签发'))
    expect(button).toBeDefined()
    await button!.trigger('click')
    await flushPromises()

    expect(api['issueLicensesBatch']).toHaveBeenCalledTimes(1)
    expect(api['issueLicensesBatch']).toHaveBeenCalledWith({
      projectId: 'proj-a',
      deviceIds: [device.deviceId, deviceB.deviceId],
      expiresAt: localInputToUtc('2026-11-11T08:00')
    })
  })

  it('中控证书已过期时禁用签发并给出原因', async () => {
    api['currentControlCertificate']!.mockResolvedValue(
      ok({ ...certificate, expiresAt: '2026-01-01T00:00:00Z' })
    )
    const wrapper = mount(IssueView)
    await flushPromises()

    expect(wrapper.text()).toContain('中控证书已过期，不能继续签发')
    const button = findIssueButton(wrapper)
    expect(button?.attributes('disabled')).toBeDefined()
    expect(api['issueLicense']).not.toHaveBeenCalled()
  })
})
