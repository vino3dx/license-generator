import { listAuditLogs } from '@core/db'
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
import { importControlCertificate, loadVerifiedControlCertificate, toControlCertificateDto } from './control'
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
  readonly maintenance: {
    reconcile(): ReconcileResultDto
  }
}

export function createLicenseServices(dependencies: ServiceDependencies): LicenseServices {
  const deps: ResolvedDependencies = resolveDependencies(dependencies)

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
    maintenance: {
      reconcile: () => reconcileLicenseStorage(deps)
    }
  }
}

export { ServiceError, isServiceError, toServiceErrorPayload } from './errors'
export { FileDelegatedKeyStore, createInMemoryDelegatedKeyStore, samePublicKey } from './delegated-key'
export type { DelegatedKey, DelegatedKeyStore } from './delegated-key'
export { FsLicenseFileStore } from './license-files'
export type { LicenseFileStore } from './license-files'
export type { ServiceDependencies } from './context'
