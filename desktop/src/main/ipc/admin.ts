import { ipcMain } from 'electron'
import { ServiceError, toServiceErrorPayload } from '@core/services'
import { ADMIN_IPC_CHANNELS } from '@shared/license/admin-contract'
import type { IpcResult } from '@shared/license/service-contract'
import { getLicenseRuntime, getLicenseRuntimeError, type LicenseRuntime } from '../license-runtime'

export interface AdminIpcOptions {
  /** 便于测试注入：生产环境使用 getLicenseRuntime() */
  readonly runtime?: () => Pick<LicenseRuntime, 'services'>
}

/**
 * 管理员会话 IPC。
 *
 * 约束：
 * - 口令只在主进程比较（scrypt + timingSafeEqual），渲染进程拿不到哈希；
 * - 口令字段在 IPC 边界先做形态收敛，空值/非字符串直接拒绝；
 * - 返回状态只包含"是否解锁/剩余时间/剩余尝试次数"，不含任何派生值。
 */
export function registerAdminIpc(options: AdminIpcOptions = {}): void {
  const getRuntime = options.runtime ?? getLicenseRuntime

  const handlers: ReadonlyArray<readonly [string, (...args: unknown[]) => unknown]> = [
    [ADMIN_IPC_CHANNELS.adminStatus, () => getRuntime().services.admin.status()],
    [
      ADMIN_IPC_CHANNELS.adminSetup,
      (input) => getRuntime().services.admin.setup(requirePassword(input))
    ],
    [
      ADMIN_IPC_CHANNELS.adminUnlock,
      (input) => getRuntime().services.admin.unlock(requirePassword(input))
    ],
    [ADMIN_IPC_CHANNELS.adminLock, () => getRuntime().services.admin.lock()],
    [
      ADMIN_IPC_CHANNELS.adminChangePassword,
      (input) => {
        const record = asRecord(input)
        return getRuntime().services.admin.changePassword(
          requireField(record, 'currentPassword'),
          requireField(record, 'newPassword')
        )
      }
    ]
  ]

  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (...args: unknown[]): Promise<IpcResult<unknown>> => {
      const runtimeError = getLicenseRuntimeError()
      if (runtimeError !== null) {
        return { ok: false, error: runtimeError }
      }
      try {
        const result = await handler(...args.slice(1))
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

function requirePassword(input: unknown): string {
  return requireField(asRecord(input), 'password')
}

function requireField(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ServiceError('invalid_argument', `${field} 必须是非空字符串`)
  }
  return value
}
