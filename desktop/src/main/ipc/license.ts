import { ipcMain } from 'electron'
import { ServiceError, toServiceErrorPayload } from '@core/services'
import { LICENSE_IPC_CHANNELS, type IpcResult } from '@shared/license/service-contract'
import { pickControlCertificateText } from '../control-file'
import { getLicenseRuntime, getLicenseRuntimeError, type LicenseRuntime } from '../license-runtime'

/**
 * 需要管理员解锁的通道（写操作/影响授权能力）。
 *
 * 这里的判定是安全边界的一部分：即使界面隐藏了按钮，直接调用这些通道也会被拒绝。
 * 只读查询（项目/设备/授权列表、证书状态、审计）不要求解锁，便于现场查看。
 */
const SENSITIVE_CHANNELS: ReadonlySet<string> = new Set([
  LICENSE_IPC_CHANNELS.deviceRegister,
  LICENSE_IPC_CHANNELS.deviceUnbind,
  LICENSE_IPC_CHANNELS.deviceLock,
  LICENSE_IPC_CHANNELS.deviceUnlock,
  LICENSE_IPC_CHANNELS.controlImport,
  LICENSE_IPC_CHANNELS.delegatedKeyImport,
  LICENSE_IPC_CHANNELS.licenseIssue,
  LICENSE_IPC_CHANNELS.licenseBatchIssue,
  LICENSE_IPC_CHANNELS.licenseRenew
])

export interface LicenseIpcOptions {
  /** 便于测试注入：生产环境使用 getLicenseRuntime() */
  readonly runtime?: () => Pick<LicenseRuntime, 'services' | 'vendorKeyConfigured'>
}

/**
 * 授权业务 IPC。
 *
 * 约束：
 * - 渲染进程只能传纯数据（ID/文本/时间），不接受任何文件路径；
 * - 所有校验都在业务层，这里只做参数形态收敛与错误封包；
 * - 敏感通道在执行前逐次校验管理员会话，未解锁直接返回 admin_locked；
 * - 不在这里暴露数据库句柄、文件系统或密钥。
 */
export function registerLicenseIpc(options: LicenseIpcOptions = {}): void {
  const getRuntime = options.runtime ?? getLicenseRuntime
  const handlers: ReadonlyArray<readonly [string, (...args: unknown[]) => unknown]> = [
    [LICENSE_IPC_CHANNELS.projectList, () => getRuntime().services.projects.list()],
    [
      LICENSE_IPC_CHANNELS.projectCreate,
      (input) => {
        const record = asRecord(input)
        return getRuntime().services.projects.create({
          projectId: requireString(record['projectId'], 'projectId'),
          name: requireString(record['name'], 'name')
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.projectUpdate,
      (input) => {
        const record = asRecord(input)
        return getRuntime().services.projects.update({
          projectId: requireString(record['projectId'], 'projectId'),
          name: requireString(record['name'], 'name')
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.deviceList,
      (options) => {
        const record = asRecord(options)
        return getRuntime().services.devices.list({
          projectId: optionalString(record['projectId']),
          includeUnbound: record['includeUnbound'] === true
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.deviceRegister,
      (input) => {
        const record = asRecord(input)
        return getRuntime().services.devices.register({
          projectId: requireString(record['projectId'], 'projectId'),
          deviceId: requireString(record['deviceId'], 'deviceId')
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.deviceUnbind,
      (input) => {
        const record = asRecord(input)
        return getRuntime().services.devices.unbind({
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
        return getRuntime().services.devices.lock({
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
        return getRuntime().services.devices.unlock({
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
        return getRuntime().services.devices.status({
          projectId: requireString(record['projectId'], 'projectId'),
          deviceId: requireString(record['deviceId'], 'deviceId')
        })
      }
    ],
    [
      LICENSE_IPC_CHANNELS.controlImport,
      (envelopeText) => getRuntime().services.control.importCertificate(String(envelopeText ?? ''))
    ],
    [
      // 由主进程弹系统文件对话框并读取文本：渲染进程只能拿到证书内容，拿不到任意路径读取能力
      LICENSE_IPC_CHANNELS.controlPickFile,
      () => pickControlCertificateText()
    ],
    [LICENSE_IPC_CHANNELS.controlCurrent, () => getRuntime().services.control.current()],
    [LICENSE_IPC_CHANNELS.controlLast, () => getRuntime().services.control.last()],
    [LICENSE_IPC_CHANNELS.quotaUsage, () => getRuntime().services.control.quota()],
    [
      LICENSE_IPC_CHANNELS.delegatedKeyStatus,
      () => getRuntime().services.delegatedKeys.status()
    ],
    [
      LICENSE_IPC_CHANNELS.delegatedKeyImport,
      (pemText) => getRuntime().services.delegatedKeys.import(String(pemText ?? ''))
    ],
    [
      LICENSE_IPC_CHANNELS.vendorKeyStatus,
      () => ({ configured: getRuntime().vendorKeyConfigured })
    ],
    [
      LICENSE_IPC_CHANNELS.licenseIssue,
      (input) => {
        const record = asRecord(input)
        return getRuntime().services.licensing.issue({
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
        return getRuntime().services.licensing.issueBatch({
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
        return getRuntime().services.licensing.renew({
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
        return getRuntime().services.licensing.list({
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
        return getRuntime().services.audit.list({
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
      const sensitive = SENSITIVE_CHANNELS.has(channel)
      try {
        if (sensitive) {
          // 逐次校验：解锁后空闲超时会在这一行被判定并拒绝，而不是只在解锁时判断一次
          getRuntime().services.admin.requireUnlocked()
        }
        // Electron 的 handle 回调第一个参数是 event，这里已由包装层去掉
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


