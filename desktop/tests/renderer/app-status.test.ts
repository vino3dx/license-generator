// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlCertificateDto, IpcResult } from '@shared/license/service-contract'
import App from '@renderer/App.vue'

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

const certificate: ControlCertificateDto = {
  licenseId: 'VND-TEST-0001',
  kid: 'kid',
  issuedAt: '2026-10-01T00:00:00Z',
  expiresAt: '2030-10-01T00:00:00Z',
  importedAt: '2026-10-23T00:00:00Z',
  isActive: true,
  projectIds: ['proj-a'],
  maxDevices: 5,
  features: []
}

let currentCert: ControlCertificateDto | null
let lastCert: ControlCertificateDto | null
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  currentCert = certificate
  lastCert = null
  api = {
    listProjects: vi.fn(async () => ok([])),
    createProject: vi.fn(async () => ok({ projectId: 'proj-a', name: 'A', status: 'active', createdAt: '2026-10-23T00:00:00Z' })),
    updateProject: vi.fn(async () => ok({ projectId: 'proj-a', name: 'A', status: 'active', createdAt: '2026-10-23T00:00:00Z' })),
    currentControlCertificate: vi.fn(async () => ok(currentCert)),
    lastControlCertificate: vi.fn(async () => ok(lastCert)),
    quota: vi.fn(async () => ok({ controlLicenseId: 'VND-TEST-0001', maxDevices: 5, usedDevices: 0 })),
    vendorKeyStatus: vi.fn(async () => ok({ configured: true })),
    delegatedKeyStatus: vi.fn(async () => ok({ configured: true, matchesControl: true, location: 'keys/delegated.key.pem' })),
    listDevices: vi.fn(async () => ok([])),
    registerDevice: vi.fn(),
    unbindDevice: vi.fn(),
    lockDevice: vi.fn(),
    unlockDevice: vi.fn(),
    deviceStatus: vi.fn(),
    importControlCertificate: vi.fn(),
    pickControlCertificateFile: vi.fn(),
    importDelegatedKey: vi.fn(),
    issueLicense: vi.fn(),
    issueLicensesBatch: vi.fn(),
    renewLicense: vi.fn(),
    listAuditLogs: vi.fn(async () => ok([]))
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

describe('顶部证书状态', () => {
  it('有效证书显示有效', async () => {
    const wrapper = mount(App, { global: { stubs: { teleport: true } } })
    await flushPromises()
    expect(wrapper.text()).toContain('中控授权有效（VND-TEST-0001）')
  })

  it('从未导入时提示未导入', async () => {
    currentCert = null
    lastCert = null
    const wrapper = mount(App, { global: { stubs: { teleport: true } } })
    await flushPromises()
    expect(wrapper.text()).toContain('未导入中控授权证书')
  })

  it('一次性证书用完后显示已作废，并提示导入新证书', async () => {
    currentCert = null
    lastCert = { ...certificate, isActive: false }
    const wrapper = mount(App, { global: { stubs: { teleport: true } } })
    await flushPromises()
    expect(wrapper.text()).toContain('已作废')
    expect(wrapper.text()).toContain('需导入新证书')
  })

  it('最近导入仍是生效态但当前校验不通过时，显示已过期或无效', async () => {
    currentCert = null
    lastCert = { ...certificate, isActive: true }
    const wrapper = mount(App, { global: { stubs: { teleport: true } } })
    await flushPromises()
    expect(wrapper.text()).toContain('已过期或无效')
  })
})
