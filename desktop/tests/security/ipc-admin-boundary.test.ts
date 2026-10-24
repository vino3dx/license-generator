// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_IPC_CHANNELS } from '@shared/license/admin-contract'
import { LICENSE_IPC_CHANNELS, type IpcResult } from '@shared/license/service-contract'
import { createHarness, FIXED_NOW, type Harness } from '../services/harness'

/**
 * 真实 IPC 边界测试：不调用业务函数，而是通过 ipcMain 注册后的 handler 调用，
 * 验证"即使绕过界面直接调用敏感通道，也会被主进程拒绝"。
 * electron 被替换为最小 mock，业务服务与数据库是真实实现。
 */
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn)
    }
  },
  app: { getPath: () => '.' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

const { registerAdminIpc } = await import('../../src/main/ipc/admin')
const { registerLicenseIpc } = await import('../../src/main/ipc/license')

const PASSWORD = 'correct horse battery'
let harness: Harness
let nowMs: number

beforeEach(() => {
  handlers.clear()
  nowMs = FIXED_NOW.getTime()
  harness = createHarness({ clock: () => new Date(nowMs) })
  registerAdminIpc({ runtime: () => ({ services: harness.services }) })
  registerLicenseIpc({
    runtime: () => ({ services: harness.services, vendorKeyConfigured: true })
  })
})

afterEach(() => {
  harness.cleanup()
})

async function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  const handler = handlers.get(channel)
  if (handler === undefined) {
    throw new Error(`通道未注册: ${channel}`)
  }
  return (await handler({}, ...args)) as IpcResult<T>
}

function codeOf(result: IpcResult<unknown>): string {
  return result.ok ? 'ok' : result.error.code
}

async function setupProjectAndCertificate(): Promise<void> {
  expect(codeOf(await invoke(LICENSE_IPC_CHANNELS.projectCreate, { projectId: 'proj-a', name: 'A' }))).toBe(
    'ok'
  )
  expect(codeOf(await invoke(LICENSE_IPC_CHANNELS.controlImport, harness.controlEnvelope()))).toBe('ok')
}

describe('未解锁时的 IPC 边界', () => {
  it('直接调用签发、登记、证书与私钥导入都会被主进程拒绝', async () => {
    expect(codeOf(await invoke(LICENSE_IPC_CHANNELS.deviceRegister, { projectId: 'proj-a', deviceId: 'dev-1' }))).toBe(
      'admin_locked'
    )
    expect(
      codeOf(await invoke(LICENSE_IPC_CHANNELS.licenseIssue, { projectId: 'proj-a', deviceId: 'dev-1' }))
    ).toBe('admin_locked')
    expect(
      codeOf(
        await invoke(LICENSE_IPC_CHANNELS.licenseBatchIssue, { projectId: 'proj-a', deviceIds: ['dev-1'] })
      )
    ).toBe('admin_locked')
    expect(
      codeOf(await invoke(LICENSE_IPC_CHANNELS.licenseRenew, { projectId: 'proj-a', deviceId: 'dev-1' }))
    ).toBe('admin_locked')
    expect(
      codeOf(await invoke(LICENSE_IPC_CHANNELS.controlImport, harness.controlEnvelope()))
    ).toBe('admin_locked')
    expect(
      codeOf(await invoke(LICENSE_IPC_CHANNELS.delegatedKeyImport, '-----BEGIN PRIVATE KEY-----'))
    ).toBe('admin_locked')
    expect(
      codeOf(await invoke(LICENSE_IPC_CHANNELS.deviceUnbind, { projectId: 'proj-a', deviceId: 'dev-1', reason: 'x' }))
    ).toBe('admin_locked')
  })

  it('只读查询不需要解锁（现场可以查看状态）', async () => {
    expect(codeOf(await invoke(LICENSE_IPC_CHANNELS.projectList))).toBe('ok')
    expect(codeOf(await invoke(LICENSE_IPC_CHANNELS.deviceList, {}))).toBe('ok')
    expect(codeOf(await invoke(LICENSE_IPC_CHANNELS.licenseList, {}))).toBe('ok')
    expect(codeOf(await invoke(LICENSE_IPC_CHANNELS.auditList, { limit: 10 }))).toBe('ok')
    const status = await invoke(ADMIN_IPC_CHANNELS.adminStatus)
    expect(status.ok).toBe(true)
    if (status.ok) {
      expect((status.value as { credentialConfigured: boolean }).credentialConfigured).toBe(false)
      expect((status.value as { unlocked: boolean }).unlocked).toBe(false)
    }
  })

  it('通过 IPC 设置弱口令同样被拒绝', async () => {
    expect(codeOf(await invoke(ADMIN_IPC_CHANNELS.adminSetup, { password: 'short' }))).toBe(
      'admin_password_weak'
    )
    const status = await invoke(ADMIN_IPC_CHANNELS.adminStatus)
    expect(status.ok && (status.value as { credentialConfigured: boolean }).credentialConfigured).toBe(false)
  })
})

describe('解锁后的 IPC 行为', () => {
  it('设置口令即解锁，敏感操作可以正常执行', async () => {
    const setup = await invoke(ADMIN_IPC_CHANNELS.adminSetup, { password: PASSWORD })
    expect(setup.ok).toBe(true)
    expect(setup.ok && (setup.value as { unlocked: boolean }).unlocked).toBe(true)

    await setupProjectAndCertificate()
    expect(
      codeOf(await invoke(LICENSE_IPC_CHANNELS.deviceRegister, { projectId: 'proj-a', deviceId: 'dev-1' }))
    ).toBe('ok')
    const issued = await invoke(LICENSE_IPC_CHANNELS.licenseIssue, {
      projectId: 'proj-a',
      deviceId: 'dev-1'
    })
    expect(issued.ok).toBe(true)
    if (issued.ok) {
      expect((issued.value as { fileState: string }).fileState).toBe('written')
    }
  })

  it('手动锁定后立即回到只读，敏感调用被拒', async () => {
    await invoke(ADMIN_IPC_CHANNELS.adminSetup, { password: PASSWORD })
    await setupProjectAndCertificate()
    expect(codeOf(await invoke(ADMIN_IPC_CHANNELS.adminLock))).toBe('ok')

    expect(
      codeOf(await invoke(LICENSE_IPC_CHANNELS.deviceRegister, { projectId: 'proj-a', deviceId: 'dev-1' }))
    ).toBe('admin_locked')
    // 只读仍可用
    expect(codeOf(await invoke(LICENSE_IPC_CHANNELS.deviceList, {}))).toBe('ok')
  })

  it('空闲超时后，下一次敏感调用被逐次校验拦下', async () => {
    await invoke(ADMIN_IPC_CHANNELS.adminSetup, { password: PASSWORD })
    await setupProjectAndCertificate()

    nowMs += 16 * 60 * 1000
    expect(
      codeOf(await invoke(LICENSE_IPC_CHANNELS.deviceRegister, { projectId: 'proj-a', deviceId: 'dev-1' }))
    ).toBe('admin_locked')

    const status = await invoke(ADMIN_IPC_CHANNELS.adminStatus)
    expect(status.ok && (status.value as { unlocked: boolean }).unlocked).toBe(false)

    // 重新解锁后恢复
    expect(codeOf(await invoke(ADMIN_IPC_CHANNELS.adminUnlock, { password: PASSWORD }))).toBe('ok')
    expect(
      codeOf(await invoke(LICENSE_IPC_CHANNELS.deviceRegister, { projectId: 'proj-a', deviceId: 'dev-1' }))
    ).toBe('ok')
  })

  it('口令错误通过 IPC 返回稳定错误码，且不会泄露口令', async () => {
    await invoke(ADMIN_IPC_CHANNELS.adminSetup, { password: PASSWORD })
    await invoke(ADMIN_IPC_CHANNELS.adminLock)
    const failed = await invoke(ADMIN_IPC_CHANNELS.adminUnlock, { password: 'wrong password' })
    expect(codeOf(failed)).toBe('admin_invalid_password')
    expect(JSON.stringify(failed)).not.toContain('wrong password')
    expect(JSON.stringify(failed)).not.toContain(PASSWORD)
  })
})
