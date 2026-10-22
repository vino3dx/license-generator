import { describe, expect, it } from 'vitest'
import { isServiceError } from '@core/services'
import { withServices } from './harness'

function expectServiceCode(action: () => unknown, code: string): void {
  try {
    action()
  } catch (error) {
    if (!isServiceError(error)) {
      throw error
    }
    expect(error.code).toBe(code)
    return
  }
  throw new Error(`期望抛出 ${code}，但调用成功返回`)
}

describe('项目编辑', () => {
  it('可以修改项目名称，列表立即反映新名称', () => {
    withServices(({ services }) => {
      services.projects.create({ projectId: 'proj-a', name: '旧名称' })
      const updated = services.projects.update({ projectId: 'proj-a', name: '新名称' })
      expect(updated.name).toBe('新名称')
      expect(updated.projectId).toBe('proj-a')
      expect(services.projects.list()[0]?.name).toBe('新名称')
    })
  })

  it('项目 ID 与创建时间不因编辑而变化', () => {
    withServices(({ services }) => {
      const created = services.projects.create({ projectId: 'proj-a', name: '原名' })
      const updated = services.projects.update({ projectId: 'proj-a', name: '改名' })
      expect(updated.projectId).toBe(created.projectId)
      expect(updated.createdAt).toBe(created.createdAt)
      expect(updated.status).toBe(created.status)
    })
  })

  it('名称相同时幂等返回，不产生多余审计', () => {
    withServices(({ services }) => {
      services.projects.create({ projectId: 'proj-a', name: '同名' })
      const before = services.audit.list({ action: 'project_update' }).length
      const result = services.projects.update({ projectId: 'proj-a', name: '同名' })
      expect(result.name).toBe('同名')
      expect(services.audit.list({ action: 'project_update' })).toHaveLength(before)
    })
  })

  it('编辑不存在的项目返回 not_found', () => {
    withServices(({ services }) => {
      expectServiceCode(() => services.projects.update({ projectId: 'proj-x', name: '任意' }), 'not_found')
    })
  })

  it('空名称与超长名称被拒绝', () => {
    withServices(({ services }) => {
      services.projects.create({ projectId: 'proj-a', name: '原名' })
      expectServiceCode(() => services.projects.update({ projectId: 'proj-a', name: '   ' }), 'invalid_argument')
      expectServiceCode(
        () => services.projects.update({ projectId: 'proj-a', name: 'x'.repeat(129) }),
        'invalid_argument'
      )
      expect(services.projects.list()[0]?.name).toBe('原名')
    })
  })

  it('编辑写入审计，记录改名前后', () => {
    withServices(({ services }) => {
      services.projects.create({ projectId: 'proj-a', name: '旧名称' })
      services.projects.update({ projectId: 'proj-a', name: '新名称' })
      const logs = services.audit.list({ action: 'project_update' })
      expect(logs).toHaveLength(1)
      expect(logs[0]?.targetId).toBe('proj-a')
      expect(logs[0]?.result).toBe('success')
      expect(logs[0]?.context).toContain('旧名称')
      expect(logs[0]?.context).toContain('新名称')
    })
  })
})
