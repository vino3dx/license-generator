// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_IPC_CHANNELS } from '@shared/license/admin-contract'
import { HUB_IPC_CHANNELS, type HubStatusDto } from '@shared/license/hub-contract'
import { LICENSE_IPC_CHANNELS, type IpcResult } from '@shared/license/service-contract'
import { createHarness, FIXED_NOW, type Harness } from '../services/harness'

/**
 * Hub 控制通道的权限边界：启动/停止会改变本机网络暴露状态，必须已解锁；
 * 状态与最近请求是只读信息，只读模式下可查看。
 * 这里 mock 掉 electron 与真实 socket，只验证 IPC 层的守卫与参数收敛。
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
const { registerHubIpc } = await import('../../src/main/ipc/hub')
const { registerLicenseIpc } = await import('../../src/main/ipc/license')

const PASSWORD = 'correct horse battery'
let harness: Harness
let started: number
let stopped: number

function statusOf(state: HubStatusDto['state']): HubStatusDto {
  return {
    state,
    listenAddress: '127.0.0.1',
    advertiseAddress: '127.0.0.1',
    udpPort: 47820,
    tcpPort: 47821,
    startedAt: state === 'running' ? '2026-10-24T00:00:00Z' : null,
    error: null,
    clientSchemaSupported: false,
    clientSchemaReason: '插件 v1 / 中控 v3',
    activeConnections: 0,
    totalRequests: 0
  }
}

beforeEach(() => {
  handlers.clear()
  started = 0
  stopped = 0
  harness = createHarness({ clock: () => FIXED_NOW })
  registerAdminIpc({ runtime: () => ({ services: harness.services }) })
  registerLicenseIpc({
    runtime: () => ({ services: harness.services, vendorKeyConfigured: true })
  })
  registerHubIpc({
    runtime: () => ({ services: harness.services }),
    hub: () => ({
      start: async () => {
        started += 1
        return statusOf('running')
      },
      stop: async () => {
        stopped += 1
        return statusOf('stopped')
      },
      status: () => statusOf('stopped')
    }),
    status: () => statusOf('stopped')
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

describe('Hub IPC 权限边界', () => {
  it('未解锁时启动/停止被拒绝，网络端口不会被打开', async () => {
    expect(codeOf(await invoke(HUB_IPC_CHANNELS.hubStart))).toBe('admin_locked')
    expect(codeOf(await invoke(HUB_IPC_CHANNELS.hubStop))).toBe('admin_locked')
    expect(started).toBe(0)
    expect(stopped).toBe(0)
  })

  it('只读模式可以查看 Hub 状态与最近请求', async () => {
    const status = await invoke(HUB_IPC_CHANNELS.hubStatus)
    expect(status.ok).toBe(true)
    if (status.ok) {
      expect((status.value as HubStatusDto).state).toBe('stopped')
      expect((status.value as HubStatusDto).clientSchemaSupported).toBe(false)
    }
    expect(codeOf(await invoke(HUB_IPC_CHANNELS.hubRequests, { limit: 10 }))).toBe('ok')
  })

  it('解锁后可以启动与停止，且状态来自真实返回值', async () => {
    await invoke(ADMIN_IPC_CHANNELS.adminSetup, { password: PASSWORD })
    const startedResult = await invoke(HUB_IPC_CHANNELS.hubStart)
    expect(startedResult.ok).toBe(true)
    if (startedResult.ok) {
      expect((startedResult.value as HubStatusDto).state).toBe('running')
    }
    expect(started).toBe(1)

    const stoppedResult = await invoke(HUB_IPC_CHANNELS.hubStop)
    expect(stoppedResult.ok).toBe(true)
    expect(stopped).toBe(1)
  })

  it('锁定后立即回到只读，无法再控制 Hub', async () => {
    await invoke(ADMIN_IPC_CHANNELS.adminSetup, { password: PASSWORD })
    await invoke(ADMIN_IPC_CHANNELS.adminLock)
    expect(codeOf(await invoke(HUB_IPC_CHANNELS.hubStart))).toBe('admin_locked')
    expect(started).toBe(0)
  })

  it('Hub 控制不影响授权业务通道的既有守卫', async () => {
    // 未解锁时签发仍被拒，说明两套守卫互不覆盖也互不放宽
    expect(
      codeOf(await invoke(LICENSE_IPC_CHANNELS.licenseIssue, { projectId: 'proj-a', deviceId: 'dev-1' }))
    ).toBe('admin_locked')
    await invoke(ADMIN_IPC_CHANNELS.adminSetup, { password: PASSWORD })
    // 解锁后仍是授权业务错误（缺证书），而不是 admin_locked
    const issued = await invoke(LICENSE_IPC_CHANNELS.licenseIssue, { projectId: 'proj-a', deviceId: 'dev-1' })
    expect(issued.ok).toBe(false)
    if (!issued.ok) {
      expect(issued.error.code).not.toBe('admin_locked')
    }
  })
})
