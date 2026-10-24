// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ControlCertificateDto,
  DeviceDto,
  DeviceLicenseStatusDto,
  IpcResult,
  LicenseDto,
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

function deviceOf(projectId: string, deviceId: string): DeviceDto {
  return {
    projectId,
    deviceId,
    registeredAt: '2026-10-22T06:00:00Z',
    locked: false,
    lockedAt: null,
    unbindAt: null
  }
}

function licenseFor(
  projectId: string,
  deviceId: string,
  daysFromNow: number,
  overrides: Partial<LicenseDto> = {}
): LicenseDto {
  const expiresAt = `${new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 19)}Z`
  return {
    licenseId: `MCH-${deviceId}-${String(daysFromNow)}`,
    projectId,
    deviceId,
    controlLicenseId: 'VND-TEST-0001',
    issuedAt: '2026-10-01T00:00:00Z',
    expiresAt,
    status: 'active',
    payloadSha256: 'hash',
    fileName: `MCH-${deviceId}.json`,
    fileState: 'written',
    supersededBy: null,
    ...overrides
  }
}

let projects: ProjectDto[]
let devices: DeviceDto[]
let licenses: LicenseDto[]
let currentCert: ControlCertificateDto | null
let lastCert: ControlCertificateDto | null
let importedCert: ControlCertificateDto
let quotaUsed: number
let deviceListFailure: { code: string; message: string } | null
let issueFailure: Record<string, { code: string; message: string } | null>
let createFailure: { projectId: string; code: string; message: string } | null
let registerBehavior: Record<string, { code: string; message: string } | null>
let statusResult: DeviceLicenseStatusDto
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  projects = [projectOf('proj-a', '客户 A')]
  devices = []
  licenses = []
  currentCert = certificate
  lastCert = null
  importedCert = certificate
  quotaUsed = 0
  deviceListFailure = null
  issueFailure = {}
  createFailure = null
  registerBehavior = {}
  statusResult = {
    device: deviceOf('proj-a', 'DEV-1'),
    license: null,
    file: { ok: false, code: 'no_license' }
  }
  api = {
    listProjects: vi.fn(async () => ok([...projects])),
    createProject: vi.fn(async (input: { projectId: string; name: string }) => {
      if (createFailure !== null && createFailure.projectId === input.projectId) {
        return fail(createFailure.code, createFailure.message)
      }
      if (projects.some((item) => item.projectId === input.projectId)) {
        return fail('conflict', `项目 ${input.projectId} 已存在`)
      }
      const created = projectOf(input.projectId, input.name)
      projects = [...projects, created]
      return ok(created)
    }),
    updateProject: vi.fn(async (input: { projectId: string; name: string }) => ok(projectOf(input.projectId, input.name))),
    currentControlCertificate: vi.fn(async () => ok(currentCert)),
    lastControlCertificate: vi.fn(async () => ok(lastCert)),
    quota: vi.fn(async () =>
      currentCert === null
        ? fail('control_certificate_missing', '没有生效的中控证书')
        : ok({ controlLicenseId: currentCert.licenseId, maxDevices: currentCert.maxDevices, usedDevices: quotaUsed })
    ),
    vendorKeyStatus: vi.fn(async () => ok({ configured: true })),
    delegatedKeyStatus: vi.fn(async () =>
      ok({ configured: true, matchesControl: true, location: 'keys/delegated.key.pem' })
    ),
    listDevices: vi.fn(async (options?: { projectId?: string; includeUnbound?: boolean }) => {
      if (deviceListFailure !== null) {
        return fail(deviceListFailure.code, deviceListFailure.message)
      }
      const list = devices.filter(
        (device) => options?.projectId === undefined || device.projectId === options.projectId
      )
      return ok(options?.includeUnbound === true ? list : list.filter((device) => device.unbindAt === null))
    }),
    listLicenses: vi.fn(async (options?: { projectId?: string; deviceId?: string; limit?: number }) => {
      const list = licenses.filter((item) => {
        if (options?.projectId !== undefined && item.projectId !== options.projectId) {
          return false
        }
        if (options?.deviceId !== undefined && item.deviceId !== options.deviceId) {
          return false
        }
        return true
      })
      return ok(list.slice(0, options?.limit ?? 200))
    }),
    registerDevice: vi.fn(async (input: { projectId: string; deviceId: string }) => {
      const failure = registerBehavior[input.deviceId]
      if (failure !== undefined && failure !== null) {
        return fail(failure.code, failure.message)
      }
      const created = deviceOf(input.projectId, input.deviceId)
      devices = [...devices, created]
      return ok(created)
    }),
    unbindDevice: vi.fn(async () => ok(deviceOf('proj-a', 'DEV-1'))),
    lockDevice: vi.fn(async (input: { projectId: string; deviceId: string }) =>
      ok({ ...deviceOf(input.projectId, input.deviceId), locked: true })
    ),
    unlockDevice: vi.fn(async (input: { projectId: string; deviceId: string }) =>
      ok(deviceOf(input.projectId, input.deviceId))
    ),
    deviceStatus: vi.fn(async () => ok(statusResult)),
    importControlCertificate: vi.fn(async () => ok(importedCert)),
    pickControlCertificateFile: vi.fn(async () => ok(null)),
    importDelegatedKey: vi.fn(async () =>
      ok({ configured: true, matchesControl: true, location: 'keys/delegated.key.pem' })
    ),
    issueLicense: vi.fn(async (input: { projectId: string; deviceId: string }) => {
      const failure = issueFailure[input.projectId]
      if (failure !== undefined && failure !== null) {
        return fail(failure.code, failure.message)
      }
      return ok(licenseFor(input.projectId, input.deviceId, 20, { licenseId: `MCH-${input.deviceId}-NEW` }))
    }),
    issueLicensesBatch: vi.fn(async (input: { projectId: string; deviceIds: readonly string[] }) => {
      const failure = issueFailure[input.projectId]
      if (failure !== undefined && failure !== null) {
        return fail(failure.code, failure.message)
      }
      return ok({
        issued: input.deviceIds.map((deviceId) =>
          licenseFor(input.projectId, deviceId, 30, { licenseId: `MCH-${deviceId}-BATCH` })
        )
      })
    }),
    renewLicense: vi.fn(async (input: { projectId: string; deviceId: string }) =>
      ok(licenseFor(input.projectId, input.deviceId, 90, { licenseId: `MCH-${input.deviceId}-RENEW` }))
    ),
    listAuditLogs: vi.fn(async () => ok([]))
  }
  Object.defineProperty(window, 'aegis', {
    value: {
      license: api,
      admin: {
        status: vi.fn(async () =>
          ok({
            credentialConfigured: true,
            unlocked: true,
            idleRemainingMs: 15 * 60 * 1000,
            idleTimeoutMs: 15 * 60 * 1000,
            lockedOutUntil: null,
            remainingAttempts: 5
          })
        ),
        setup: vi.fn(),
        unlock: vi.fn(),
        lock: vi.fn(),
        changePassword: vi.fn()
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

async function mountWorkbench(): Promise<VueWrapper> {
  const wrapper = mount(LicenseManageView, { global: { stubs: { teleport: true } } })
  await flushPromises()
  await flushPromises()
  return wrapper
}

function buttonByText(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('button').find((button) => button.text() === text)
}

function deviceCheckbox(wrapper: VueWrapper, deviceId: string) {
  return wrapper
    .findAll('input[type="checkbox"]')
    .find((input) => input.attributes('aria-label') === `选择设备 ${deviceId}`)
}

function deviceRowIds(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('table tbody tr')
    .map((row) => row.findAll('td')[1]?.text().split(' ')[0] ?? '')
}

function headerTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAll('table thead th').map((cell) => cell.text())
}

/** 走真实 UI 路径：展开首次配置 → 打开导入弹窗 → 填内容 → 点确认 */
async function importCertificate(wrapper: VueWrapper): Promise<void> {
  const expand = buttonByText(wrapper, '查看配置')
  if (expand !== undefined) {
    await expand.trigger('click')
    await flushPromises()
  }
  const open = buttonByText(wrapper, '导入证书') ?? buttonByText(wrapper, '更换证书')
  expect(open).toBeDefined()
  await open!.trigger('click')
  await flushPromises()
  await wrapper.find('.modal textarea').setValue('{"aegis":"license-envelope"}')
  const confirm = wrapper
    .findAll('button')
    .filter((button) => button.text() === '导入证书' && button.classes().includes('btn--primary'))
  await confirm[0]!.trigger('click')
  await flushPromises()
}

describe('设备中心：设备列表聚合', () => {
  it('跨工程聚合设备，并按归属工程区分，不出现项目切换界面', async () => {
    projects = [projectOf('proj-a', '客户 A'), projectOf('proj-b', '客户 B')]
    devices = [deviceOf('proj-a', 'DEV-A1'), deviceOf('proj-b', 'DEV-B1')]
    licenses = [licenseFor('proj-a', 'DEV-A1', 20), licenseFor('proj-b', 'DEV-B1', 60)]
    const wrapper = await mountWorkbench()

    expect(deviceRowIds(wrapper).sort()).toEqual(['DEV-A1', 'DEV-B1'])
    expect(headerTexts(wrapper)).toContain('归属工程')
    expect(wrapper.text()).toContain('客户 A')
    expect(wrapper.text()).toContain('客户 B')
    // 设备中心不再有左侧项目列表与项目切换入口
    expect(wrapper.find('.project-item').exists()).toBe(false)
    expect(wrapper.find('.workbench__side').exists()).toBe(false)
  })

  it('单工程证书且设备同属一个工程时不显示归属列', async () => {
    devices = [deviceOf('proj-a', 'DEV-1')]
    const wrapper = await mountWorkbench()

    expect(headerTexts(wrapper)).not.toContain('归属工程')
    expect(wrapper.text()).toContain('证书唯一工程，自动填充')
  })

  it('设备列表读取失败时显示真实错误，不展示陈旧数据', async () => {
    devices = [deviceOf('proj-a', 'DEV-1')]
    deviceListFailure = { code: 'unexpected', message: '数据库忙，请重试' }
    const wrapper = await mountWorkbench()

    expect(wrapper.text()).toContain('数据库忙，请重试')
    expect(deviceRowIds(wrapper)).toEqual([])
  })
})

describe('设备中心：登记与归属', () => {
  it('单工程证书自动填充归属，登记不需要选择工程', async () => {
    const wrapper = await mountWorkbench()

    expect(wrapper.find('select').exists()).toBe(false)
    await wrapper.find('textarea').setValue('DEV-1\n\n  DEV-1  \nDEV-2\n')
    await buttonByText(wrapper, '登记设备')!.trigger('click')
    await flushPromises()

    expect(api['registerDevice']).toHaveBeenCalledTimes(2)
    expect(api['registerDevice']).toHaveBeenNthCalledWith(1, { projectId: 'proj-a', deviceId: 'DEV-1' })
    expect(api['registerDevice']).toHaveBeenNthCalledWith(2, { projectId: 'proj-a', deviceId: 'DEV-2' })
    expect(wrapper.text()).toContain('新增 2 台')
  })

  it('多工程证书时必须显式选择归属，登记按所选工程执行', async () => {
    currentCert = { ...certificate, projectIds: ['proj-a', 'proj-b'] }
    projects = [projectOf('proj-a', '客户 A'), projectOf('proj-b', '客户 B')]
    const wrapper = await mountWorkbench()

    const select = wrapper.find('select')
    expect(select.exists()).toBe(true)
    expect((select.element as HTMLSelectElement).value).toBe('proj-a')

    await select.setValue('proj-b')
    await wrapper.find('textarea').setValue('DEV-B1')
    await buttonByText(wrapper, '登记设备')!.trigger('click')
    await flushPromises()

    expect(api['registerDevice']).toHaveBeenCalledWith({ projectId: 'proj-b', deviceId: 'DEV-B1' })
  })

  it('通配范围不自动创建工程，操作员输入真实工程 ID 后才建立关联并登记', async () => {
    projects = []
    currentCert = { ...certificate, projectIds: ['*'] }
    const wrapper = await mountWorkbench()

    expect(api['createProject']).not.toHaveBeenCalled()
    // 归属未确定前不允许登记（按钮禁用）
    expect(buttonByText(wrapper, '登记设备')?.attributes('disabled')).toBeDefined()

    const ownerInput = wrapper
      .findAll('input')
      .find((input) => input.attributes('list') === 'aegis-known-projects')
    expect(ownerInput).toBeDefined()
    await ownerInput!.setValue('proj-real')

    await wrapper.find('textarea').setValue('DEV-1')
    const register = buttonByText(wrapper, '登记设备')
    expect(register?.attributes('disabled')).toBeUndefined()
    await register!.trigger('click')
    await flushPromises()

    expect(api['createProject']).toHaveBeenCalledWith({ projectId: 'proj-real', name: 'proj-real' })
    expect(api['registerDevice']).toHaveBeenCalledWith({ projectId: 'proj-real', deviceId: 'DEV-1' })
  })

  it('通配范围可通过弹窗添加归属工程', async () => {
    projects = []
    currentCert = { ...certificate, projectIds: ['*'] }
    const wrapper = await mountWorkbench()

    await buttonByText(wrapper, '添加归属工程')!.trigger('click')
    await flushPromises()

    const modal = wrapper.find('.modal')
    const inputs = modal.findAll('input')
    await inputs[0]!.setValue('proj-x')
    await inputs[1]!.setValue('展厅主控')
    await modal.findAll('button').find((button) => button.text() === '添加')!.trigger('click')
    await flushPromises()

    expect(api['createProject']).toHaveBeenCalledWith({ projectId: 'proj-x', name: '展厅主控' })
  })

  it('一台失败不阻断其他设备，并明确显示部分成功', async () => {
    registerBehavior = { 'DEV-1': { code: 'conflict', message: '设备 DEV-1 已绑定在另一个工程' } }
    const wrapper = await mountWorkbench()

    await wrapper.find('textarea').setValue('DEV-1\nDEV-2')
    await buttonByText(wrapper, '登记设备')!.trigger('click')
    await flushPromises()

    expect(api['registerDevice']).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('部分成功：新增 1 台')
    expect(wrapper.text()).toContain('失败 1 台')
    expect(wrapper.text()).toContain('设备 DEV-1 已绑定在另一个工程')
    expect(wrapper.text()).toContain('已登记')
  })

  it('额度用尽时登记入口被禁用（不在界面绕过额度）', async () => {
    quotaUsed = 5
    const wrapper = await mountWorkbench()

    expect(buttonByText(wrapper, '登记设备')?.attributes('disabled')).toBeDefined()
  })

  it('多工程归属下拉只列出证书范围内的工程（不放宽范围校验）', async () => {
    currentCert = { ...certificate, projectIds: ['proj-a', 'proj-b'] }
    projects = [projectOf('proj-a', '客户 A'), projectOf('proj-b', '客户 B'), projectOf('proj-c', '范围外')]
    const wrapper = await mountWorkbench()

    const options = wrapper.findAll('select option').map((option) => option.attributes('value'))
    expect(options).toEqual(['proj-a', 'proj-b'])
    expect(options).not.toContain('proj-c')
  })
})

describe('设备中心：首次配置与工程关联初始化', () => {
  it('没有证书时提示导入中控证书，签发不可用', async () => {
    currentCert = null
    lastCert = null
    const wrapper = await mountWorkbench()

    expect(wrapper.text()).toContain('尚未导入中控授权证书')
    expect(wrapper.text()).toContain('需要配置')
    expect(buttonByText(wrapper, '签发授权')?.attributes('disabled')).toBeDefined()
  })

  it('证书已导入但委托私钥未配置时提示导入私钥', async () => {
    api['delegatedKeyStatus'] = vi.fn(async () =>
      ok({ configured: false, matchesControl: null, location: 'keys/delegated.key.pem' })
    )
    const wrapper = await mountWorkbench()

    expect(wrapper.text()).toContain('本机未配置委托签发私钥')
    expect(buttonByText(wrapper, '导入私钥')).toBeDefined()
    expect(buttonByText(wrapper, '签发授权')?.attributes('disabled')).toBeDefined()
  })

  it('委托私钥与证书不匹配时显示真实原因', async () => {
    api['delegatedKeyStatus'] = vi.fn(async () =>
      ok({ configured: true, matchesControl: false, location: 'keys/delegated.key.pem' })
    )
    const wrapper = await mountWorkbench()

    expect(wrapper.text()).toContain('与证书不匹配')
    expect(wrapper.text()).toContain('委托私钥与中控证书不匹配')
  })

  it('证书已过期时禁止签发', async () => {
    currentCert = { ...certificate, expiresAt: '2020-01-01T00:00:00Z' }
    const wrapper = await mountWorkbench()

    expect(wrapper.text()).toContain('中控证书已过期')
    expect(buttonByText(wrapper, '签发授权')?.attributes('disabled')).toBeDefined()
  })

  it('配置完整时显示配置完整，日常不再要求重复导入', async () => {
    const wrapper = await mountWorkbench()

    expect(wrapper.text()).toContain('配置完整')
    expect(wrapper.text()).not.toContain('需要配置')
    expect(buttonByText(wrapper, '查看配置')).toBeDefined()
  })

  it('进入工作台按证书范围自动建立缺失的工程关联，已有工程不重复创建', async () => {
    projects = [projectOf('proj-a', '客户 A')]
    currentCert = { ...certificate, projectIds: ['proj-a', 'proj-b'] }
    const wrapper = await mountWorkbench()

    expect(api['createProject']).toHaveBeenCalledTimes(1)
    expect(api['createProject']).toHaveBeenCalledWith({ projectId: 'proj-b', name: 'proj-b' })
    expect(wrapper.text()).toContain('客户 A')
  })

  it('证书导入后按工程 ID 自动建立关联，并显示初始化结果', async () => {
    projects = []
    currentCert = null
    importedCert = { ...certificate, projectIds: ['proj-a', 'proj-b'] }
    const wrapper = await mountWorkbench()

    await importCertificate(wrapper)

    expect(api['createProject']).toHaveBeenCalledWith({ projectId: 'proj-a', name: 'proj-a' })
    expect(api['createProject']).toHaveBeenCalledWith({ projectId: 'proj-b', name: 'proj-b' })
    expect(wrapper.text()).toContain('工程关联初始化完成')
    expect(wrapper.text()).toContain('新建 2 个')
  })

  it('初始化失败时显示工程 ID 与真实原因，不伪装成初始化完成', async () => {
    projects = []
    currentCert = { ...certificate, projectIds: ['proj-x'] }
    createFailure = { projectId: 'proj-x', code: 'conflict', message: '项目 proj-x 已存在' }
    const wrapper = await mountWorkbench()

    expect(wrapper.text()).toContain('工程关联初始化失败')
    expect(wrapper.text()).toContain('proj-x：项目 proj-x 已存在')
    expect(wrapper.text()).not.toContain('工程关联初始化完成')
  })
})

describe('设备中心：批量签发与续期', () => {
  it('单台签发后给出中控实际文件名与交付到 license.dat 的说明', async () => {
    devices = [deviceOf('proj-a', 'DEV-1')]
    const wrapper = await mountWorkbench()

    await deviceCheckbox(wrapper, 'DEV-1')!.setValue(true)
    await buttonByText(wrapper, '签发授权')!.trigger('click')
    await flushPromises()

    expect(api['issueLicense']).toHaveBeenCalledWith({ projectId: 'proj-a', deviceId: 'DEV-1' })
    expect(wrapper.text()).toContain('MCH-DEV-1-NEW')
    expect(wrapper.text()).toContain('C:/aegis-data/licenses/MCH-DEV-1.json')
    expect(wrapper.text()).toContain('重命名为')
    expect(wrapper.text()).toContain('license.dat')
    expect(wrapper.text()).toContain('exe 同目录')
  })

  it('同一工程多台设备走批量签发并逐台展示结果', async () => {
    devices = [deviceOf('proj-a', 'DEV-1'), deviceOf('proj-a', 'DEV-2')]
    const wrapper = await mountWorkbench()

    await deviceCheckbox(wrapper, 'DEV-1')!.setValue(true)
    await deviceCheckbox(wrapper, 'DEV-2')!.setValue(true)
    await buttonByText(wrapper, '批量签发 2 台')!.trigger('click')
    await flushPromises()

    expect(api['issueLicensesBatch']).toHaveBeenCalledWith({ projectId: 'proj-a', deviceIds: ['DEV-1', 'DEV-2'] })
    expect(wrapper.text()).toContain('签发成功，共 2 台')
    expect(wrapper.text()).toContain('MCH-DEV-1-BATCH')
    expect(wrapper.text()).toContain('MCH-DEV-2-BATCH')
    expect(wrapper.text()).toContain('C:/aegis-data/licenses/MCH-DEV-1.json')
    expect(wrapper.text()).toContain('C:/aegis-data/licenses/MCH-DEV-2.json')
  })

  it('跨工程批量签发按归属工程分别调用，不放宽服务层的单工程限制', async () => {
    currentCert = { ...certificate, projectIds: ['proj-a', 'proj-b'] }
    projects = [projectOf('proj-a', '客户 A'), projectOf('proj-b', '客户 B')]
    devices = [deviceOf('proj-a', 'DEV-A1'), deviceOf('proj-b', 'DEV-B1')]
    const wrapper = await mountWorkbench()

    await deviceCheckbox(wrapper, 'DEV-A1')!.setValue(true)
    await deviceCheckbox(wrapper, 'DEV-B1')!.setValue(true)
    await buttonByText(wrapper, '批量签发 2 台')!.trigger('click')
    await flushPromises()

    expect(api['issueLicense']).toHaveBeenCalledWith({ projectId: 'proj-a', deviceId: 'DEV-A1' })
    expect(api['issueLicense']).toHaveBeenCalledWith({ projectId: 'proj-b', deviceId: 'DEV-B1' })
    expect(wrapper.text()).toContain('签发成功，共 2 台')
  })

  it('某个归属工程失败时明确显示部分成功与失败原因', async () => {
    currentCert = { ...certificate, projectIds: ['proj-a', 'proj-b'] }
    projects = [projectOf('proj-a', '客户 A'), projectOf('proj-b', '客户 B')]
    devices = [deviceOf('proj-a', 'DEV-A1'), deviceOf('proj-b', 'DEV-B1')]
    issueFailure = { 'proj-b': { code: 'project_not_in_scope', message: '项目 proj-b 不在中控授权范围内' } }
    const wrapper = await mountWorkbench()

    await deviceCheckbox(wrapper, 'DEV-A1')!.setValue(true)
    await deviceCheckbox(wrapper, 'DEV-B1')!.setValue(true)
    await buttonByText(wrapper, '批量签发 2 台')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('部分成功：已签发 1 台')
    expect(wrapper.text()).toContain('项目 proj-b 不在中控授权范围内')
    expect(wrapper.text()).toContain('失败')
  })

  it('单台续期调用续期接口并刷新当前授权状态', async () => {
    devices = [deviceOf('proj-a', 'DEV-1')]
    licenses = [licenseFor('proj-a', 'DEV-1', 10)]
    const wrapper = await mountWorkbench()
    const listLicensesMock = api['listLicenses']!
    const listCallCount = listLicensesMock.mock.calls.length

    await deviceCheckbox(wrapper, 'DEV-1')!.setValue(true)
    await buttonByText(wrapper, '续期选中设备')!.trigger('click')
    await flushPromises()

    expect(api['renewLicense']).toHaveBeenCalledWith({ projectId: 'proj-a', deviceId: 'DEV-1' })
    expect(listLicensesMock.mock.calls.length).toBeGreaterThan(listCallCount)
    expect(api['issueLicensesBatch']).not.toHaveBeenCalled()
  })

  it('多台续期只为全部持有当前授权的设备开放', async () => {
    devices = [deviceOf('proj-a', 'DEV-1'), deviceOf('proj-a', 'DEV-2')]
    licenses = [licenseFor('proj-a', 'DEV-1', 10)]
    const wrapper = await mountWorkbench()

    await deviceCheckbox(wrapper, 'DEV-1')!.setValue(true)
    await deviceCheckbox(wrapper, 'DEV-2')!.setValue(true)

    expect(wrapper.text()).toContain('没有可续期的当前授权')
    expect(buttonByText(wrapper, '续期 2 台')?.attributes('disabled')).toBeDefined()
  })

  it('多台续期为已有授权生成替代授权（走批量签发路径）', async () => {
    devices = [deviceOf('proj-a', 'DEV-1'), deviceOf('proj-a', 'DEV-2')]
    licenses = [licenseFor('proj-a', 'DEV-1', 10), licenseFor('proj-a', 'DEV-2', 12)]
    const wrapper = await mountWorkbench()

    await deviceCheckbox(wrapper, 'DEV-1')!.setValue(true)
    await deviceCheckbox(wrapper, 'DEV-2')!.setValue(true)
    const renew = buttonByText(wrapper, '续期 2 台')
    expect(renew?.attributes('disabled')).toBeUndefined()
    await renew!.trigger('click')
    await flushPromises()

    expect(api['issueLicensesBatch']).toHaveBeenCalledWith({ projectId: 'proj-a', deviceIds: ['DEV-1', 'DEV-2'] })
    expect(wrapper.text()).toContain('续期成功，共 2 台')
  })
})

describe('设备中心：授权状态与记录', () => {
  it('没有当前授权记录的设备显示未签发', async () => {
    devices = [deviceOf('proj-a', 'DEV-1')]
    const wrapper = await mountWorkbench()

    expect(wrapper.text()).toContain('未签发')
    expect(deviceRowIds(wrapper)).toEqual(['DEV-1'])
  })

  it('已过期与 30 天内到期排在前面，未签发排最后', async () => {
    devices = [
      deviceOf('proj-a', 'DEV-VALID'),
      deviceOf('proj-a', 'DEV-NONE'),
      deviceOf('proj-a', 'DEV-EXPIRED'),
      deviceOf('proj-a', 'DEV-SOON')
    ]
    licenses = [
      licenseFor('proj-a', 'DEV-VALID', 200),
      licenseFor('proj-a', 'DEV-EXPIRED', -5),
      licenseFor('proj-a', 'DEV-SOON', 10)
    ]
    const wrapper = await mountWorkbench()

    expect(deviceRowIds(wrapper)).toEqual(['DEV-EXPIRED', 'DEV-SOON', 'DEV-VALID', 'DEV-NONE'])
    expect(wrapper.text()).toContain('已过期')
    expect(wrapper.text()).toContain('即将到期')
    expect(wrapper.text()).toContain('剩 10 天')
  })

  it('被替代的历史授权不会被当成当前授权', async () => {
    devices = [deviceOf('proj-a', 'DEV-1')]
    licenses = [
      licenseFor('proj-a', 'DEV-1', 300, { licenseId: 'MCH-OLD', supersededBy: 'MCH-NEW' }),
      licenseFor('proj-a', 'DEV-1', 5, { licenseId: 'MCH-NEW' })
    ]
    const wrapper = await mountWorkbench()

    expect(wrapper.text()).toContain('剩 5 天')
    expect(wrapper.text()).not.toContain('剩 300 天')
  })

  it('已吊销或未落盘的授权不算当前授权', async () => {
    devices = [deviceOf('proj-a', 'DEV-1')]
    licenses = [
      licenseFor('proj-a', 'DEV-1', 300, { licenseId: 'MCH-REVOKED', status: 'revoked' }),
      licenseFor('proj-a', 'DEV-1', 200, { licenseId: 'MCH-PENDING', fileState: 'pending' })
    ]
    const wrapper = await mountWorkbench()

    expect(wrapper.text()).toContain('未签发')
    expect(wrapper.text()).not.toContain('剩 300 天')
    expect(wrapper.text()).not.toContain('剩 200 天')
  })

  it('授权记录弹窗按设备读取历史记录，并标注当前与已替代', async () => {
    devices = [deviceOf('proj-a', 'DEV-1')]
    licenses = [
      licenseFor('proj-a', 'DEV-1', 300, { licenseId: 'MCH-OLD', supersededBy: 'MCH-NEW' }),
      licenseFor('proj-a', 'DEV-1', 20, { licenseId: 'MCH-NEW' })
    ]
    statusResult = {
      device: deviceOf('proj-a', 'DEV-1'),
      license: licenses[1]!,
      file: { ok: true, code: null }
    }
    const wrapper = await mountWorkbench()

    await buttonByText(wrapper, '授权记录')!.trigger('click')
    await flushPromises()

    expect(api['listLicenses']).toHaveBeenCalledWith({ deviceId: 'DEV-1', limit: 50 })
    const modal = wrapper.find('.modal')
    expect(modal.text()).toContain('历史授权记录（2）')
    expect(modal.text()).toContain('MCH-OLD')
    expect(modal.text()).toContain('已被替代')
    expect(modal.text()).toContain('MCH-NEW')
    expect(modal.text()).toContain('当前有效')
    expect(modal.text()).toContain('文件校验通过')
  })

  it('锁定设备后按钮切换为解锁，并按设备的归属工程调用', async () => {
    devices = [{ ...deviceOf('proj-a', 'DEV-1'), locked: true, lockedAt: '2026-10-22T07:00:00Z' }]
    const wrapper = await mountWorkbench()

    expect(wrapper.text()).toContain('已锁定')
    await buttonByText(wrapper, '解锁')!.trigger('click')
    await flushPromises()

    expect(api['unlockDevice']).toHaveBeenCalledWith({ projectId: 'proj-a', deviceId: 'DEV-1' })
  })
})
