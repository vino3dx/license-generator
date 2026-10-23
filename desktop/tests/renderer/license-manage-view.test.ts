// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ControlCertificateDto,
  DeviceDto,
  IpcResult,
  ProjectDto
} from '@shared/license/service-contract'
import LicenseManageView from '@renderer/views/LicenseManageView.vue'

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

function fail(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } as never }
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

function projectOf(projectId: string, name = projectId): ProjectDto {
  return { projectId, name, status: 'active', createdAt: '2026-10-22T06:00:00Z' }
}

function deviceOf(deviceId: string): DeviceDto {
  return {
    projectId: 'proj-a',
    deviceId,
    registeredAt: '2026-10-22T06:00:00Z',
    locked: false,
    lockedAt: null,
    unbindAt: null
  }
}

const license = {
  licenseId: 'MCH-20261023000000-ABCDEF',
  projectId: 'proj-a',
  deviceId: 'DEV-1',
  controlLicenseId: 'VND-TEST-0001',
  issuedAt: '2026-10-23T00:00:00Z',
  expiresAt: '2026-11-12T00:00:00Z',
  status: 'active',
  payloadSha256: 'hash',
  fileName: 'MCH-20261023000000-ABCDEF.json',
  fileState: 'written',
  supersededBy: null
} as const

let projects: ProjectDto[]
let devices: DeviceDto[]
let currentCert: ControlCertificateDto | null
let lastCert: ControlCertificateDto | null
let importedCert: ControlCertificateDto
let quotaUsed: number
let createFailure: { projectId: string; code: string; message: string } | null
let registerBehavior: Record<string, { code: string; message: string } | null>
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  projects = [projectOf('proj-a', '客户 A')]
  devices = []
  currentCert = certificate
  lastCert = null
  importedCert = certificate
  quotaUsed = 0
  createFailure = null
  registerBehavior = {}
  api = {
    listProjects: vi.fn(async () => ok([...projects])),
    createProject: vi.fn(async (input: { projectId: string; name: string }) => {
      if (createFailure !== null && createFailure.projectId === input.projectId) {
        return fail(createFailure.code, createFailure.message)
      }
      const created = projectOf(input.projectId, input.name)
      projects = [...projects, created]
      return ok(created)
    }),
    updateProject: vi.fn(async (input: { projectId: string; name: string }) => ok(projectOf(input.projectId, input.name))),
    currentControlCertificate: vi.fn(async () => ok(currentCert)),
    lastControlCertificate: vi.fn(async () => ok(lastCert)),
    quota: vi.fn(async () => ok({ controlLicenseId: 'VND-TEST-0001', maxDevices: 5, usedDevices: quotaUsed })),
    vendorKeyStatus: vi.fn(async () => ok({ configured: true })),
    delegatedKeyStatus: vi.fn(async () =>
      ok({ configured: true, matchesControl: true, location: 'keys/delegated.key.pem' })
    ),
    listDevices: vi.fn(async () => ok([...devices])),
    registerDevice: vi.fn(async (input: { projectId: string; deviceId: string }) => {
      const failure = registerBehavior[input.deviceId]
      if (failure !== undefined && failure !== null) {
        return fail(failure.code, failure.message)
      }
      const created = { ...deviceOf(input.deviceId), projectId: input.projectId }
      devices = [...devices, created]
      return ok(created)
    }),
    unbindDevice: vi.fn(async () => ok(deviceOf('DEV-1'))),
    lockDevice: vi.fn(async () => ok(deviceOf('DEV-1'))),
    unlockDevice: vi.fn(async () => ok(deviceOf('DEV-1'))),
    deviceStatus: vi.fn(async () => ok({ device: deviceOf('DEV-1'), license: null, file: { ok: false, code: 'no_license' } })),
    importControlCertificate: vi.fn(async () => ok(importedCert)),
    pickControlCertificateFile: vi.fn(async () => ok(null)),
    importDelegatedKey: vi.fn(async () =>
      ok({ configured: true, matchesControl: true, location: 'keys/delegated.key.pem' })
    ),
    issueLicense: vi.fn(async () => ok(license)),
    issueLicensesBatch: vi.fn(async () => ok({ issued: [license] })),
    renewLicense: vi.fn(async () => ok(license)),
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

function mountView(): VueWrapper {
  return mount(LicenseManageView, { global: { stubs: { teleport: true } } })
}

/** 走真实 UI 路径：打开导入弹窗 → 填内容 → 点确认 */
async function importCertificate(wrapper: VueWrapper): Promise<void> {
  // 已有证书时按钮文案是「更换证书」，两种情况都走同一个导入弹窗
  const open = wrapper
    .findAll('button')
    .find((button) => button.text() === '导入证书' || button.text() === '更换证书')
  expect(open).toBeDefined()
  await open!.trigger('click')
  await flushPromises()
  const textareas = wrapper.findAll('textarea')
  await textareas[textareas.length - 1]!.setValue('{"aegis":"license-envelope"}')
  const confirm = wrapper
    .findAll('button')
    .filter((button) => button.text() === '导入证书' && button.classes().includes('btn--primary'))
  await confirm[0]!.trigger('click')
  await flushPromises()
}

describe('授权管理：证书导入后的项目初始化', () => {
  it('按证书列出的项目 ID 自动创建缺失项目', async () => {
    projects = []
    importedCert = { ...certificate, projectIds: ['proj-a', 'proj-b'] }
    const wrapper = mountView()
    await flushPromises()

    await importCertificate(wrapper)

    expect(api['createProject']).toHaveBeenCalledTimes(2)
    expect(api['createProject']).toHaveBeenNthCalledWith(1, { projectId: 'proj-a', name: 'proj-a' })
    expect(api['createProject']).toHaveBeenNthCalledWith(2, { projectId: 'proj-b', name: 'proj-b' })
    expect(wrapper.text()).toContain('项目初始化完成')
    expect(wrapper.text()).toContain('新建 2 个')
  })

  it('已存在的项目不重复创建，也不覆盖已有名称', async () => {
    projects = [projectOf('proj-a', '客户 A')]
    importedCert = { ...certificate, projectIds: ['proj-a', 'proj-b'] }
    const wrapper = mountView()
    await flushPromises()

    await importCertificate(wrapper)

    expect(api['createProject']).toHaveBeenCalledTimes(1)
    expect(api['createProject']).toHaveBeenCalledWith({ projectId: 'proj-b', name: 'proj-b' })
    expect(wrapper.text()).toContain('客户 A')
    expect(wrapper.text()).toContain('已存在 1 个')
  })

  it('通配项目范围（*）不自动生成任何项目，只提示手工输入', async () => {
    projects = []
    importedCert = { ...certificate, projectIds: ['*'] }
    const wrapper = mountView()
    await flushPromises()

    await importCertificate(wrapper)

    expect(api['createProject']).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('通配项目范围')
    expect(wrapper.text()).toContain('手工创建')
  })

  it('初始化失败时显示项目 ID 与真实原因，不伪装成初始化完成', async () => {
    projects = []
    importedCert = { ...certificate, projectIds: ['proj-x'] }
    createFailure = { projectId: 'proj-x', code: 'conflict', message: '项目 proj-x 已存在' }
    const wrapper = mountView()
    await flushPromises()

    await importCertificate(wrapper)

    expect(wrapper.text()).toContain('项目初始化失败')
    expect(wrapper.text()).toContain('proj-x：项目 proj-x 已存在')
    expect(wrapper.text()).toContain('此时还不能签发')
    expect(wrapper.text()).not.toContain('项目初始化完成')
  })
})

describe('授权管理：多行设备登记', () => {
  it('去空行、去重后逐台登记', async () => {
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('textarea').setValue('DEV-1\n\n  DEV-1  \nDEV-2\n')
    const register = wrapper.findAll('button').find((button) => button.text() === '登记到当前项目')
    await register!.trigger('click')
    await flushPromises()

    expect(api['registerDevice']).toHaveBeenCalledTimes(2)
    expect(api['registerDevice']).toHaveBeenNthCalledWith(1, { projectId: 'proj-a', deviceId: 'DEV-1' })
    expect(api['registerDevice']).toHaveBeenNthCalledWith(2, { projectId: 'proj-a', deviceId: 'DEV-2' })
    expect(wrapper.text()).toContain('新增 2 台')
  })

  it('一台失败不阻断其他设备，并明确显示部分成功', async () => {
    registerBehavior = { 'DEV-1': { code: 'conflict', message: '设备 DEV-1 已绑定在项目 proj-b' } }
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('textarea').setValue('DEV-1\nDEV-2')
    const register = wrapper.findAll('button').find((button) => button.text() === '登记到当前项目')
    await register!.trigger('click')
    await flushPromises()

    expect(api['registerDevice']).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('部分成功：新增 1 台')
    expect(wrapper.text()).toContain('失败 1 台')
    expect(wrapper.text()).toContain('设备 DEV-1 已绑定在项目 proj-b')
    expect(wrapper.text()).toContain('已登记')
    expect(wrapper.text()).toContain('失败')
  })

  it('额度用尽时登记入口被禁用（不在界面绕过额度）', async () => {
    quotaUsed = 5
    const wrapper = mountView()
    await flushPromises()

    const register = wrapper.findAll('button').find((button) => button.text() === '登记到当前项目')
    expect(register?.attributes('disabled')).toBeDefined()
  })
})

describe('授权管理：证书状态与签发门槛', () => {
  it('证书已作废时提示需导入新证书，且签发按钮不可用', async () => {
    currentCert = null
    lastCert = { ...certificate, isActive: false }
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('已作废')
    expect(wrapper.text()).toContain('请导入新证书后再签发')
    const issue = wrapper.findAll('button').find((button) => button.text().includes('签发授权'))
    expect(issue?.attributes('disabled')).toBeDefined()
  })

  it('没有证书时签发按钮不可用，并说明缺少证书', async () => {
    currentCert = null
    lastCert = null
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('尚未导入中控授权证书')
    const issue = wrapper.findAll('button').find((button) => button.text().includes('签发授权'))
    expect(issue?.attributes('disabled')).toBeDefined()
  })

  it('签发结果给出中控实际文件名与交付到 license.dat 的说明', async () => {
    devices = [deviceOf('DEV-1')]
    const wrapper = mountView()
    await flushPromises()

    const checkbox = wrapper.findAll('input[type="checkbox"]')[0]
    await checkbox!.setValue(true)
    const issue = wrapper.findAll('button').find((button) => button.text().includes('签发授权'))
    await issue!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('C:/aegis-data/licenses/MCH-20261023000000-ABCDEF.json')
    expect(wrapper.text()).toContain('重命名为')
    expect(wrapper.text()).toContain('license.dat')
    expect(wrapper.text()).toContain('exe 同目录')
  })
})
