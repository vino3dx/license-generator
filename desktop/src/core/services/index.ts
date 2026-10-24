import { listAuditLogs } from '@core/db'
import type { AdminStatusDto } from '@shared/license/admin-contract'
import type { DeviceRequestDto } from '@shared/license/delivery-contract'
import type { PullResultDto } from '@shared/license/hub-contract'
import type {
  AuditLogDto,
  BatchIssueResultDto,
  ControlCertificateDto,
  DelegatedKeyStatusDto,
  DeviceDto,
  DeviceLicenseStatusDto,
  LicenseDto,
  ProjectDto,
  QuotaUsageDto,
  ReconcileResultDto
} from '@shared/license/service-contract'
import { AdminSession } from './admin-session'
import {
  clientSchemaReason,
  handleHubPull,
  isClientSchemaSupported,
  listHubRequests,
  type HubPullInput
} from './delivery'
import {
  createProject,
  getDeviceLicenseStatus,
  listDevicesService,
  listProjectsService,
  registerDevice,
  setDeviceLock,
  unbindDevice,
  updateProject
} from './catalog'
import { importControlCertificate, loadLatestControlCertificate, loadVerifiedControlCertificate, toControlCertificateDto } from './control'
import { getDelegatedKeyStatus, importDelegatedKey } from './key-admin'
import { resolveDependencies, type ResolvedDependencies, type ServiceDependencies } from './context'
import {
  getQuotaUsage,
  issueLicense,
  issueLicensesBatch,
  listLicensesService,
  reconcileLicenseStorage,
  renewLicense
} from './issuance'

/**
 * 业务服务门面：界面层（IPC）只能通过这里访问数据库与授权文件。
 * 所有权限、额度、有效期校验都在这一层，绕过界面不能绕过校验。
 */
export interface LicenseServices {
  readonly projects: {
    create(input: { readonly projectId: string; readonly name: string }): ProjectDto
    update(input: { readonly projectId: string; readonly name: string }): ProjectDto
    list(): ProjectDto[]
  }
  readonly devices: {
    register(input: { readonly projectId: string; readonly deviceId: string }): DeviceDto
    list(options?: { readonly projectId?: string; readonly includeUnbound?: boolean }): DeviceDto[]
    unbind(input: { readonly projectId: string; readonly deviceId: string; readonly reason: string }): DeviceDto
    lock(input: { readonly projectId: string; readonly deviceId: string; readonly reason?: string }): DeviceDto
    unlock(input: { readonly projectId: string; readonly deviceId: string; readonly reason?: string }): DeviceDto
    status(input: { readonly projectId: string; readonly deviceId: string }): DeviceLicenseStatusDto
  }
  readonly control: {
    importCertificate(envelopeText: string): ControlCertificateDto
    current(): ControlCertificateDto | null
    /** 最近导入的证书（含已作废），供界面提示一次性证书状态 */
    last(): ControlCertificateDto | null
    quota(): QuotaUsageDto
  }
  readonly licensing: {
    issue(input: {
      readonly projectId: string
      readonly deviceId: string
      readonly expiresAt?: string
    }): LicenseDto
    issueBatch(input: {
      readonly projectId: string
      readonly deviceIds: readonly string[]
      readonly expiresAt?: string
    }): BatchIssueResultDto
    renew(input: { readonly projectId: string; readonly deviceId: string; readonly expiresAt?: string }): LicenseDto
    list(options?: { readonly projectId?: string; readonly deviceId?: string; readonly limit?: number }): LicenseDto[]
  }
  readonly audit: {
    list(options?: { readonly limit?: number; readonly targetId?: string; readonly action?: string }): AuditLogDto[]
  }
  readonly delegatedKeys: {
    status(): DelegatedKeyStatusDto
    import(pem: string): DelegatedKeyStatusDto
  }
  /**
   * 管理员会话：口令校验与解锁状态全部在主进程。
   * 敏感操作前必须调用 requireUnlocked()（IPC 层统一执行），不能只靠界面禁用按钮。
   */
  readonly admin: {
    status(): AdminStatusDto
    setup(password: string): AdminStatusDto
    unlock(password: string): AdminStatusDto
    lock(): AdminStatusDto
    changePassword(currentPassword: string, newPassword: string): AdminStatusDto
    requireUnlocked(): void
    touch(): void
  }
  /**
   * 局域网下发（Hub）领域逻辑：只做决策与留证，网络 I/O 在主进程 hub 模块。
   */
  readonly hub: {
    handlePull(input: HubPullInput): PullResultDto
    listRequests(options?: { readonly limit?: number; readonly deviceId?: string }): DeviceRequestDto[]
    clientSchema(): { readonly supported: boolean; readonly reason: string | null }
  }
  readonly maintenance: {
    reconcile(): ReconcileResultDto
  }
}

export function createLicenseServices(dependencies: ServiceDependencies): LicenseServices {
  const deps: ResolvedDependencies = resolveDependencies(dependencies)
  const adminSession = new AdminSession(deps)

  return {
    projects: {
      create: (input) => createProject(deps, input),
      update: (input) => updateProject(deps, input),
      list: () => listProjectsService(deps)
    },
    devices: {
      register: (input) => registerDevice(deps, input),
      list: (options) => listDevicesService(deps, options ?? {}),
      unbind: (input) => unbindDevice(deps, input),
      lock: (input) => setDeviceLock(deps, { ...input, locked: true }),
      unlock: (input) => setDeviceLock(deps, { ...input, locked: false }),
      status: (input) => getDeviceLicenseStatus(deps, input)
    },
    control: {
      importCertificate: (envelopeText) => importControlCertificate(deps, envelopeText),
      current: () => {
        try {
          const certificate = loadVerifiedControlCertificate(deps)
          return toControlCertificateDto(certificate.record, certificate.payload)
        } catch {
          return null
        }
      },
      last: () => loadLatestControlCertificate(deps),
      quota: () => getQuotaUsage(deps)
    },
    licensing: {
      issue: (input) => issueLicense(deps, input),
      issueBatch: (input) => issueLicensesBatch(deps, input),
      renew: (input) => renewLicense(deps, input),
      list: (options) => listLicensesService(deps, options ?? {})
    },
    audit: {
      list: (options) => listAuditLogs(deps.database, options ?? {})
    },
    delegatedKeys: {
      status: () => getDelegatedKeyStatus(deps),
      import: (pem) => importDelegatedKey(deps, pem)
    },
    admin: {
      status: () => adminSession.status(),
      setup: (password) => adminSession.setup(password),
      unlock: (password) => adminSession.unlock(password),
      lock: () => adminSession.lock(),
      changePassword: (currentPassword, newPassword) =>
        adminSession.changePassword(currentPassword, newPassword),
      requireUnlocked: () => adminSession.requireUnlocked(),
      touch: () => adminSession.touch()
    },
    hub: {
      handlePull: (input) => handleHubPull(deps, input),
      listRequests: (options) => listHubRequests(deps, options ?? {}),
      clientSchema: () => ({ supported: isClientSchemaSupported(), reason: clientSchemaReason() })
    },
    maintenance: {
      reconcile: () => reconcileLicenseStorage(deps)
    }
  }
}

export { ServiceError, isServiceError, toServiceErrorPayload } from './errors'
export {
  FileDelegatedKeyStore,
  createInMemoryDelegatedKeyStore,
  samePublicKey
} from './delegated-key'
export type {
  DelegatedKey,
  DelegatedKeyStore,
  KeyProtectionStatus,
  KeyProtectionState,
  KeyProtector
} from './delegated-key'
export { EncryptedFileDelegatedKeyStore } from './encrypted-key-store'
export { AdminSession, createAdminSession, DEFAULT_IDLE_TIMEOUT_MS } from './admin-session'
export type { AdminSessionOptions } from './admin-session'
export {
  activeLockout,
  assertAdminPasswordPolicy,
  clearAdminFailures,
  isAdminConfigured,
  readThrottle,
  recordAdminFailure,
  verifyAdminPassword,
  writeAdminPassword
} from './admin-credential'
export type { ThrottlePolicy, ThrottleRecord } from './admin-credential'
export {
  assertDeliveryTransition,
  canTransitionDelivery,
  deliveryIdempotencyKey,
  isDeliveryActiveState,
  isDeliveryTerminalState
} from './delivery-state'
export { FsLicenseFileStore } from './license-files'
export type { LicenseFileStore } from './license-files'
export type { ServiceDependencies } from './context'
