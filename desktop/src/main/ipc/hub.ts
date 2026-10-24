import { ipcMain } from 'electron'
import { toServiceErrorPayload } from '@core/services'
import { HUB_IPC_CHANNELS } from '@shared/license/hub-contract'
import type { IpcResult } from '@shared/license/service-contract'
import { getLicenseRuntime, getLicenseRuntimeError, type LicenseRuntime } from '../license-runtime'
import { getHubServer, getHubStatus } from '../hub/hub-runtime'

export interface HubIpcOptions {
  /** 便于测试注入 */
  readonly runtime?: () => Pick<LicenseRuntime, 'services'>
  readonly hub?: () => { start(): Promise<unknown>; stop(): Promise<unknown>; status(): unknown }
  readonly status?: () => unknown
}

/**
 * Hub 控制 IPC。
 *
 * 启动/停止会改变本机网络暴露状态，属于敏感操作，必须已解锁管理员会话；
 * 状态与最近请求是只读信息，允许在现场只读模式下查看。
 */
export function registerHubIpc(options: HubIpcOptions = {}): void {
  const getRuntime = options.runtime ?? getLicenseRuntime
  const hubOf = options.hub ?? (() => getHubServer())
  const statusOf = options.status ?? (() => getHubStatus())

  const handlers: ReadonlyArray<readonly [string, boolean, (...args: unknown[]) => unknown]> = [
    [HUB_IPC_CHANNELS.hubStatus, false, () => statusOf()],
    [
      HUB_IPC_CHANNELS.hubStart,
      true,
      async () => {
        const status = await hubOf().start()
        return status
      }
    ],
    [
      HUB_IPC_CHANNELS.hubStop,
      true,
      async () => {
        const status = await hubOf().stop()
        return status
      }
    ],
    [
      HUB_IPC_CHANNELS.hubRequests,
      false,
      (input) => {
        const record = asRecord(input)
        const limit = typeof record['limit'] === 'number' && Number.isFinite(record['limit']) ? record['limit'] : 50
        return getRuntime().services.hub.listRequests({ limit })
      }
    ]
  ]

  for (const [channel, sensitive, handler] of handlers) {
    ipcMain.handle(channel, async (...args: unknown[]): Promise<IpcResult<unknown>> => {
      const runtimeError = getLicenseRuntimeError()
      if (runtimeError !== null) {
        return { ok: false, error: runtimeError }
      }
      try {
        if (sensitive) {
          getRuntime().services.admin.requireUnlocked()
        }
        const result = await handler(...args.slice(1))
        if (sensitive) {
          getRuntime().services.admin.touch()
        }
        return { ok: true, value: result }
      } catch (error) {
        return { ok: false, error: toServiceErrorPayload(error) }
      }
    })
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
