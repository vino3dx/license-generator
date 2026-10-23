/**
 * 业务层与界面/主进程共享的 DTO 与错误码。
 * 约束：不含 Node.js 依赖，渲染进程可安全引用；也不含任何私钥或文件系统路径。
 */

export type ProjectStatus = 'active' | 'archived'

export interface ProjectDto {
  readonly projectId: string
  readonly name: string
  readonly status: ProjectStatus
  readonly createdAt: string
}

export interface DeviceDto {
  readonly projectId: string
  readonly deviceId: string
  readonly registeredAt: string
  readonly locked: boolean
  readonly lockedAt: string | null
  readonly unbindAt: string | null
}

export type LicenseStatus = 'active' | 'revoked'
export type LicenseFileState = 'pending' | 'written'

export interface LicenseDto {
  readonly licenseId: string
  readonly projectId: string
  readonly deviceId: string
  readonly controlLicenseId: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly status: LicenseStatus
  readonly payloadSha256: string
  /** 相对授权目录的文件名，不含绝对路径 */
  readonly fileName: string
  readonly fileState: LicenseFileState
  readonly supersededBy: string | null
}

export interface ControlCertificateDto {
  readonly licenseId: string
  readonly kid: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly importedAt: string
  readonly isActive: boolean
  readonly projectIds: readonly string[]
  readonly maxDevices: number
  readonly features: readonly string[]
}

export interface AuditLogDto {
  readonly id: number
  readonly at: string
  /** 操作者（第一版为当前系统用户或 local-console） */
  readonly actor: string
  readonly action: string
  readonly targetType: string
  readonly targetId: string
  readonly result: 'success' | 'failure'
  readonly errorCode: string | null
  readonly context: string | null
}

/** 授权文件校验结果：数据库状态不能替代它 */
export interface LicenseFileCheckDto {
  readonly ok: boolean
  readonly code: string | null
}

export interface DeviceLicenseStatusDto {
  readonly device: DeviceDto
  /** 数据库中最新的有效记录（不代表文件一定通过验签） */
  readonly license: LicenseDto | null
  readonly file: LicenseFileCheckDto
}

export interface QuotaUsageDto {
  readonly controlLicenseId: string
  readonly maxDevices: number
  readonly usedDevices: number
}

export interface BatchIssueResultDto {
  readonly issued: readonly LicenseDto[]
}

export interface ReconcileResultDto {
  readonly pendingRolledBack: number
  readonly orphanFilesQuarantined: number
}

/** 委托签发私钥的配置状态（只返回状态，不返回私钥内容） */
export interface DelegatedKeyStatusDto {
  readonly configured: boolean
  /** 已导入中控证书时，本机私钥是否与证书内委托公钥一致；无证书时为 null */
  readonly matchesControl: boolean | null
  /** 相对于 userData 的位置说明，不含绝对路径 */
  readonly location: string
}

/** 厂商公钥（信任根）配置状态；未配置时不能验证任何中控证书 */
export interface VendorKeyStatusDto {
  readonly configured: boolean
}

export type ServiceErrorCode =
  | 'invalid_argument'
  | 'not_found'
  | 'conflict'
  | 'vendor_key_missing'
  | 'control_certificate_missing'
  | 'control_certificate_invalid'
  | 'control_certificate_expired'
  | 'project_not_in_scope'
  | 'device_quota_exceeded'
  | 'device_unbound'
  | 'delegated_key_missing'
  | 'delegated_key_mismatch'
  | 'license_expiry_invalid'
  | 'license_file_error'
  | 'license_verification_failed'
  | 'unexpected'

export interface ServiceErrorPayload {
  readonly code: ServiceErrorCode
  readonly message: string
  readonly details?: Record<string, string | number | boolean>
}

/** IPC 统一返回：业务失败不抛异常穿过进程边界，改为结构化错误 */
export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ServiceErrorPayload }

/** 渲染进程可调用的授权业务通道（全部走 ipcMain.handle，参数只接受数据不接路径） */
export const LICENSE_IPC_CHANNELS = {
  projectList: 'license:project-list',
  projectCreate: 'license:project-create',
  projectUpdate: 'license:project-update',
  deviceList: 'license:device-list',
  deviceRegister: 'license:device-register',
  deviceUnbind: 'license:device-unbind',
  deviceLock: 'license:device-lock',
  deviceUnlock: 'license:device-unlock',
  deviceStatus: 'license:device-status',
  controlImport: 'license:control-import',
  controlPickFile: 'license:control-pick-file',
  controlCurrent: 'license:control-current',
  controlLast: 'license:control-last',
  quotaUsage: 'license:quota-usage',
  delegatedKeyStatus: 'license:delegated-key-status',
  delegatedKeyImport: 'license:delegated-key-import',
  vendorKeyStatus: 'license:vendor-key-status',
  licenseIssue: 'license:license-issue',
  licenseBatchIssue: 'license:license-batch-issue',
  licenseRenew: 'license:license-renew',
  licenseList: 'license:license-list',
  auditList: 'license:audit-list'
} as const

export type LicenseIpcChannel = (typeof LICENSE_IPC_CHANNELS)[keyof typeof LICENSE_IPC_CHANNELS]
