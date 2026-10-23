import type { AppInfo } from './ipc-contract'
import type {
  AuditLogDto,
  BatchIssueResultDto,
  ControlCertificateDto,
  DelegatedKeyStatusDto,
  DeviceDto,
  DeviceLicenseStatusDto,
  IpcResult,
  LicenseDto,
  ProjectDto,
  QuotaUsageDto,
  VendorKeyStatusDto
} from './license/service-contract'

/**
 * preload 暴露给渲染进程的最小 API 面。
 * 约束：渲染进程只能通过这里的方法访问主进程能力，拿不到 ipcRenderer、fs、数据库或私钥。
 * 所有参数都是纯数据（ID、文本），不接受文件路径。
 */
export interface AegisApi {
  getAppInfo(): Promise<AppInfo>
  license: {
    listProjects(): Promise<IpcResult<ProjectDto[]>>
    createProject(input: { readonly projectId: string; readonly name: string }): Promise<IpcResult<ProjectDto>>
    updateProject(input: { readonly projectId: string; readonly name: string }): Promise<IpcResult<ProjectDto>>

    listDevices(options?: { readonly projectId?: string; readonly includeUnbound?: boolean }): Promise<IpcResult<DeviceDto[]>>
    registerDevice(input: { readonly projectId: string; readonly deviceId: string }): Promise<IpcResult<DeviceDto>>
    unbindDevice(input: {
      readonly projectId: string
      readonly deviceId: string
      readonly reason: string
    }): Promise<IpcResult<DeviceDto>>
    lockDevice(input: {
      readonly projectId: string
      readonly deviceId: string
      readonly reason?: string
    }): Promise<IpcResult<DeviceDto>>
    unlockDevice(input: {
      readonly projectId: string
      readonly deviceId: string
      readonly reason?: string
    }): Promise<IpcResult<DeviceDto>>
    deviceStatus(input: {
      readonly projectId: string
      readonly deviceId: string
    }): Promise<IpcResult<DeviceLicenseStatusDto>>

    importControlCertificate(envelopeText: string): Promise<IpcResult<ControlCertificateDto>>
    /** 由主进程弹系统文件对话框读取证书文本；取消返回 null */
    pickControlCertificateFile(): Promise<IpcResult<string | null>>
    currentControlCertificate(): Promise<IpcResult<ControlCertificateDto | null>>
    /** 最近导入的证书（含已作废）；一次性证书规则下用于提示"证书已作废" */
    lastControlCertificate(): Promise<IpcResult<ControlCertificateDto | null>>
    quota(): Promise<IpcResult<QuotaUsageDto>>

    delegatedKeyStatus(): Promise<IpcResult<DelegatedKeyStatusDto>>
    importDelegatedKey(pemText: string): Promise<IpcResult<DelegatedKeyStatusDto>>
    vendorKeyStatus(): Promise<IpcResult<VendorKeyStatusDto>>

    issueLicense(input: {
      readonly projectId: string
      readonly deviceId: string
      readonly expiresAt?: string
    }): Promise<IpcResult<LicenseDto>>
    issueLicensesBatch(input: {
      readonly projectId: string
      readonly deviceIds: readonly string[]
      readonly expiresAt?: string
    }): Promise<IpcResult<BatchIssueResultDto>>
    renewLicense(input: {
      readonly projectId: string
      readonly deviceId: string
      readonly expiresAt?: string
    }): Promise<IpcResult<LicenseDto>>
    listLicenses(options?: {
      readonly projectId?: string
      readonly deviceId?: string
      readonly limit?: number
    }): Promise<IpcResult<LicenseDto[]>>

    listAuditLogs(options?: {
      readonly limit?: number
      readonly targetId?: string
      readonly action?: string
    }): Promise<IpcResult<AuditLogDto[]>>
  }
}
