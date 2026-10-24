// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminStatusDto } from '@shared/license/admin-contract'
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
let adminStatus: AdminStatusDto
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  currentCert = certificate
  lastCert = null
  adminStatus = {
    credentialConfigured: true,
    unlocked: true,
    idleRemainingMs: 15 * 60 * 1000,
    idleTimeoutMs: 15 * 60 * 1000,
    lockedOutUntil: null,
    remainingAttempts: 5
  }
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
    listLicenses: vi.fn(async () => ok([])),
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
      admin: {
        status: vi.fn(async () => ok(adminStatus)),
        setup: vi.fn(async () => ok(adminStatus)),
        unlock: vi.fn(async () => ok(adminStatus)),
        lock: vi.fn(async () => ok(adminStatus)),
        changePassword: vi.fn(async () => ok(adminStatus))
      },
      hub: {
        status: vi.fn(async () =>
          ok({
            state: 'stopped',
            listenAddress: '127.0.0.1',
            advertiseAddress: null,
            udpPort: 47820,
            tcpPort: 47821,
            startedAt: null,
            error: null,
            clientSchemaSupported: false,
            clientSchemaReason: '插件只接受 schema_version=1',
            activeConnections: 0,
            totalRequests: 0
          })
        ),
        start: vi.fn(),
        stop: vi.fn(),
        requests: vi.fn(async () => ok([]))
      },
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

describe('主导航', () => {
  it('只保留授权工作台与日志信息两个入口', async () => {
    const wrapper = mount(App, { global: { stubs: { teleport: true } } })
    await flushPromises()

    const entries = wrapper.findAll('.sidebar__item')
    expect(entries.length).toBe(2)
    expect(entries[0]?.text()).toContain('授权工作台')
    expect(entries[1]?.text()).toContain('日志信息')
  })
})

describe('管理员入口', () => {
  it('未解锁时显示只读模式与解锁入口', async () => {
    adminStatus = { ...adminStatus, unlocked: false }
    const wrapper = mount(App, { global: { stubs: { teleport: true } } })
    await flushPromises()

    expect(wrapper.text()).toContain('只读模式')
    expect(wrapper.findAll('button').some((button) => button.text() === '解锁')).toBe(true)
    wrapper.unmount()
  })

  it('未设置口令时提示先设置管理员口令', async () => {
    adminStatus = { ...adminStatus, credentialConfigured: false, unlocked: false }
    const wrapper = mount(App, { global: { stubs: { teleport: true } } })
    await flushPromises()

    expect(wrapper.text()).toContain('未设置管理员口令')
    expect(wrapper.findAll('button').some((button) => button.text() === '设置管理员口令')).toBe(true)
    wrapper.unmount()
  })

  it('已解锁时显示剩余空闲时间与锁定入口', async () => {
    const wrapper = mount(App, { global: { stubs: { teleport: true } } })
    await flushPromises()

    expect(wrapper.text()).toContain('已解锁')
    expect(wrapper.findAll('button').some((button) => button.text() === '锁定')).toBe(true)
    wrapper.unmount()
  })

  it('失败锁定期间显示锁定到期时间', async () => {
    adminStatus = {
      ...adminStatus,
      unlocked: false,
      lockedOutUntil: '2026-10-24T03:05:00Z',
      remainingAttempts: 0
    }
    const wrapper = mount(App, { global: { stubs: { teleport: true } } })
    await flushPromises()

    expect(wrapper.text()).toContain('登录已锁定至')
    wrapper.unmount()
  })
})
