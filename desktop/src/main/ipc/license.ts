import { ipcMain } from 'electron'
import { ServiceError, toServiceErrorPayload } from '@core/services'
import { LICENSE_IPC_CHANNELS, type IpcResult } from '@shared/license/service-contract'
import { pickControlCertificateText } from '../control-file'
import { getLicenseRuntime, getLicenseRuntimeError } from '../license-runtime'

/**
 * 授权业务 IPC。
 *
 * 约束：
 * - 渲染进程只能传纯数据（ID/文本/时间），不接受任何文件路径；
 * - 所有校验都在业务层，这里只做参数形态收敛与错误封包；
 * - 不在这里暴露数据库句柄、文件系统或密钥。
 */
export function registerLicenseIpc(): void {
  const handlers: ReadonlyArray<readonly [string, (...args: unknown[]) => unknown]> = [
    [LICENSE_IPC_CHANNELS.projectList, () => getLicenseRuntime().services.projects.list()],
    [
      LICENSE_IPC_CHANNELS.projectCreate,
      (input) => {
        const record = asRecord(input)
        return getLicenseRuntime().services.projects.create({
          projectId: requireString(record['projectId'], 'projectId'),
          name: requireString(record['name'], 'name')
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.projectUpdate,
      (input) => {
        const record = asRecord(input)
        return getLicenseRuntime().services.projects.update({
          projectId: requireString(record['projectId'], 'projectId'),
          name: requireString(record['name'], 'name')
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.deviceList,
      (options) => {
        const record = asRecord(options)
        return getLicenseRuntime().services.devices.list({
          projectId: optionalString(record['projectId']),
          includeUnbound: record['includeUnbound'] === true
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.deviceRegister,
      (input) => {
        const record = asRecord(input)
        return getLicenseRuntime().services.devices.register({
          projectId: requireString(record['projectId'], 'projectId'),
          deviceId: requireString(record['deviceId'], 'deviceId')
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.deviceUnbind,
      (input) => {
        const record = asRecord(input)
        return getLicenseRuntime().services.devices.unbind({
          projectId: requireString(record['projectId'], 'projectId'),
          deviceId: requireString(record['deviceId'], 'deviceId'),
          reason: requireString(record['reason'], 'reason')
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.deviceLock,
      (input) => {
        const record = asRecord(input)
        return getLicenseRuntime().services.devices.lock({
          projectId: requireString(record['projectId'], 'projectId'),
          deviceId: requireString(record['deviceId'], 'deviceId'),
          ...optionalReason(record['reason'])
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.deviceUnlock,
      (input) => {
        const record = asRecord(input)
        return getLicenseRuntime().services.devices.unlock({
          projectId: requireString(record['projectId'], 'projectId'),
          deviceId: requireString(record['deviceId'], 'deviceId'),
          ...optionalReason(record['reason'])
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.deviceStatus,
      (input) => {
        const record = asRecord(input)
        return getLicenseRuntime().services.devices.status({
          projectId: requireString(record['projectId'], 'projectId'),
          deviceId: requireString(record['deviceId'], 'deviceId')
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.controlImport,
      (envelopeText) => getLicenseRuntime().services.control.importCertificate(String(envelopeText ?? ''))
    ],
    [
      // 由主进程弹系统文件对话框并读取文本：渲染进程只能拿到证书内容，拿不到任意路径读取能力
      LICENSE_IPC_CHANNELS.controlPickFile,
      () => pickControlCertificateText()
    ],
    [LICENSE_IPC_CHANNELS.controlCurrent, () => getLicenseRuntime().services.control.current()],
    [LICENSE_IPC_CHANNELS.quotaUsage, () => getLicenseRuntime().services.control.quota()],
    [
      LICENSE_IPC_CHANNELS.delegatedKeyStatus,
      () => getLicenseRuntime().services.delegatedKeys.status()
    ],
    [
      LICENSE_IPC_CHANNELS.delegatedKeyImport,
      (pemText) => getLicenseRuntime().services.delegatedKeys.import(String(pemText ?? ''))
    ],
    [
      LICENSE_IPC_CHANNELS.vendorKeyStatus,
      () => ({ configured: getLicenseRuntime().vendorKeyConfigured })
    ],
    [
      LICENSE_IPC_CHANNELS.licenseIssue,
      (input) => {
        const record = asRecord(input)
        return getLicenseRuntime().services.licensing.issue({
          projectId: requireString(record['projectId'], 'projectId'),
          deviceId: requireString(record['deviceId'], 'deviceId'),
          ...optionalExpiry(record['expiresAt'])
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.licenseBatchIssue,
      (input) => {
        const record = asRecord(input)
        const deviceIds = Array.isArray(record['deviceIds']) ? record['deviceIds'].map((item) => String(item)) : []
        return getLicenseRuntime().services.licensing.issueBatch({
          projectId: requireString(record['projectId'], 'projectId'),
          deviceIds,
          ...optionalExpiry(record['expiresAt'])
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.licenseRenew,
      (input) => {
        const record = asRecord(input)
        return getLicenseRuntime().services.licensing.renew({
          projectId: requireString(record['projectId'], 'projectId'),
          deviceId: requireString(record['deviceId'], 'deviceId'),
          ...optionalExpiry(record['expiresAt'])
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.licenseList,
      (options) => {
        const record = asRecord(options)
        return getLicenseRuntime().services.licensing.list({
          projectId: optionalString(record['projectId']),
          deviceId: optionalString(record['deviceId']),
          limit: optionalNumber(record['limit'])
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.auditList,
      (options) => {
        const record = asRecord(options)
        return getLicenseRuntime().services.audit.list({
          limit: optionalNumber(record['limit']),
          targetId: optionalString(record['targetId']),
          action: optionalString(record['action'])
        })
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
        // Electron 的 handle 回调第一个参数是 event，这里已由包装层去掉
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ServiceError('invalid_argument', `${field} 必须是字符串`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalReason(value: unknown): { reason?: string } {
  return typeof value === 'string' && value.length > 0 ? { reason: value } : {}
}

function optionalExpiry(value: unknown): { expiresAt?: string } {
  return typeof value === 'string' && value.length > 0 ? { expiresAt: value } : {}
}


