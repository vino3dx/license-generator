// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResult, ProjectDto } from '@shared/license/service-contract'
import ProjectsView from '@renderer/views/ProjectsView.vue'

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

function fail(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } as never }
}

const controlCertificate = {
  licenseId: 'VND-TEST-0001',
  kid: 'kid',
  issuedAt: '2026-10-01T00:00:00Z',
  expiresAt: '2027-10-01T00:00:00Z',
  importedAt: '2026-10-22T06:00:00Z',
  isActive: true,
  projectIds: ['proj-a'],
  maxDevices: 10,
  features: []
} as const

let projects: ProjectDto[] = []
let createResult: IpcResult<ProjectDto> | null = null
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  projects = [{ projectId: 'proj-a', name: '项目 A', status: 'active', createdAt: '2026-10-22T06:00:00Z' }]
  createResult = null
  api = {
    listProjects: vi.fn(async () => ok([...projects])),
    currentControlCertificate: vi.fn(async () => ok(controlCertificate)),
    createProject: vi.fn(async (input: { projectId: string; name: string }) => {
      if (createResult !== null) {
        return createResult
      }
      const created: ProjectDto = {
        projectId: input.projectId,
        name: input.name,
        status: 'active',
        createdAt: '2026-10-22T07:00:00Z'
      }
      projects = [...projects, created]
      return ok(created)
    }),
    updateProject: vi.fn(async (input: { projectId: string; name: string }) => {
      const updated: ProjectDto = { ...projects[0]!, name: input.name }
      projects = projects.map((item) => (item.projectId === input.projectId ? updated : item))
      return ok(updated)
    })
  }
  Object.defineProperty(window, 'aegis', {
    value: { license: api, getAppInfo: vi.fn() },
    configurable: true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('项目管理页面', () => {
  it('挂载后调用业务服务并渲染真实项目数据', async () => {
    const wrapper = mount(ProjectsView)
    await flushPromises()

    expect(api['listProjects']).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('项目 A')
    expect(wrapper.text()).toContain('proj-a')
    expect(wrapper.text()).toContain('在范围内')
  })

  it('创建项目后列表立即出现新项目', async () => {
    const wrapper = mount(ProjectsView)
    await flushPromises()

    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('proj-b')
    await inputs[1]!.setValue('项目 B')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(api['createProject']).toHaveBeenCalledWith({ projectId: 'proj-b', name: '项目 B' })
    expect(wrapper.text()).toContain('项目 B')
    expect(wrapper.text()).toContain('已创建')
  })

  it('重复项目 ID 在前端拦截，不调用服务', async () => {
    const wrapper = mount(ProjectsView)
    await flushPromises()

    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('proj-a')
    await inputs[1]!.setValue('重复项目')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(api['createProject']).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('已存在')
  })

  it('非法项目 ID 给出格式错误提示', async () => {
    const wrapper = mount(ProjectsView)
    await flushPromises()

    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('带空格 的 ID')
    await inputs[1]!.setValue('项目')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(api['createProject']).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('项目 ID 只能包含')
  })

  it('业务层拒绝时展示错误码与原因', async () => {
    createResult = fail('conflict', '项目 proj-c 已存在')
    const wrapper = mount(ProjectsView)
    await flushPromises()

    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('proj-c')
    await inputs[1]!.setValue('项目 C')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('项目 proj-c 已存在')
    expect(wrapper.text()).toContain('conflict')
  })
})
