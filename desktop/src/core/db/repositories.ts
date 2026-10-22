import type {
  AuditLogDto,
  ControlCertificateDto,
  DeviceDto,
  LicenseDto,
  LicenseFileState,
  LicenseStatus,
  ProjectDto,
  ProjectStatus
} from '@shared/license/service-contract'
import { getAll, getOne, runStatement, type SqliteDatabase, type SqlRow } from './sqlite'

/* ---------------------------------- projects --------------------------------- */

export function insertProject(database: SqliteDatabase, project: ProjectDto): void {
  runStatement(
    database,
    'INSERT INTO projects (project_id, name, status, created_at) VALUES (?, ?, ?, ?)',
    project.projectId,
    project.name,
    project.status,
    project.createdAt
  )
}

export function findProject(database: SqliteDatabase, projectId: string): ProjectDto | null {
  const row = getOne(database, 'SELECT * FROM projects WHERE project_id = ?', projectId)
  return row === null ? null : mapProject(row)
}

export function listProjects(database: SqliteDatabase): ProjectDto[] {
  return getAll(database, 'SELECT * FROM projects ORDER BY created_at ASC, project_id ASC').map(mapProject)
}

/** 只允许改名称；project_id 与创建时间是稳定标识，不随编辑变化 */
export function updateProjectName(database: SqliteDatabase, projectId: string, name: string): void {
  runStatement(database, 'UPDATE projects SET name = ? WHERE project_id = ?', name, projectId)
}

function mapProject(row: SqlRow): ProjectDto {
  return {
    projectId: String(row['project_id']),
    name: String(row['name']),
    status: String(row['status']) as ProjectStatus,
    createdAt: String(row['created_at'])
  }
}

/* ---------------------------------- devices ---------------------------------- */

export interface DeviceRecord {
  readonly projectId: string
  readonly deviceId: string
  readonly registeredAt: string
  readonly locked: boolean
  readonly lockedAt: string | null
  readonly unbindAt: string | null
}

export function findDevice(database: SqliteDatabase, projectId: string, deviceId: string): DeviceDto | null {
  const row = getOne(
    database,
    'SELECT * FROM devices WHERE project_id = ? AND device_id = ?',
    projectId,
    deviceId
  )
  return row === null ? null : mapDevice(row)
}

export function findActiveDeviceById(database: SqliteDatabase, deviceId: string): DeviceDto | null {
  const row = getOne(database, 'SELECT * FROM devices WHERE device_id = ? AND unbind_at IS NULL', deviceId)
  return row === null ? null : mapDevice(row)
}

export function listDevices(
  database: SqliteDatabase,
  options: { readonly projectId?: string; readonly includeUnbound?: boolean } = {}
): DeviceDto[] {
  const conditions: string[] = []
  const params: string[] = []
  if (options.projectId !== undefined) {
    conditions.push('project_id = ?')
    params.push(options.projectId)
  }
  if (options.includeUnbound !== true) {
    conditions.push('unbind_at IS NULL')
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return getAll(
    database,
    `SELECT * FROM devices ${where} ORDER BY project_id ASC, registered_at ASC, device_id ASC`,
    ...params
  ).map(mapDevice)
}

export function insertDevice(database: SqliteDatabase, device: DeviceDto): void {
  runStatement(
    database,
    'INSERT INTO devices (project_id, device_id, registered_at, locked, locked_at, unbind_at) VALUES (?, ?, ?, ?, ?, ?)',
    device.projectId,
    device.deviceId,
    device.registeredAt,
    device.locked ? 1 : 0,
    device.lockedAt,
    device.unbindAt
  )
}

export function updateDeviceRegistration(
  database: SqliteDatabase,
  projectId: string,
  deviceId: string,
  registeredAt: string
): void {
  runStatement(
    database,
    'UPDATE devices SET registered_at = ?, unbind_at = NULL, locked = 0, locked_at = NULL WHERE project_id = ? AND device_id = ?',
    registeredAt,
    projectId,
    deviceId
  )
}

export function updateDeviceLock(
  database: SqliteDatabase,
  projectId: string,
  deviceId: string,
  locked: boolean,
  lockedAt: string | null
): void {
  runStatement(
    database,
    'UPDATE devices SET locked = ?, locked_at = ? WHERE project_id = ? AND device_id = ?',
    locked ? 1 : 0,
    lockedAt,
    projectId,
    deviceId
  )
}

export function updateDeviceUnbind(
  database: SqliteDatabase,
  projectId: string,
  deviceId: string,
  unbindAt: string
): void {
  runStatement(
    database,
    'UPDATE devices SET unbind_at = ?, locked = 0, locked_at = NULL WHERE project_id = ? AND device_id = ?',
    unbindAt,
    projectId,
    deviceId
  )
}

/**
 * 额度计算：指定项目范围内、尚未解绑的设备数量（锁定设备仍然占用名额）。
 * projectIds 为 null 表示不限项目（证书 project_ids 为 ["*"]）。
 */
export function countBoundDevices(database: SqliteDatabase, projectIds: readonly string[] | null): number {
  if (projectIds !== null && projectIds.length === 0) {
    return 0
  }
  const row =
    projectIds === null
      ? getOne(database, 'SELECT COUNT(1) AS total FROM devices WHERE unbind_at IS NULL')
      : getOne(
          database,
          `SELECT COUNT(1) AS total FROM devices WHERE unbind_at IS NULL AND project_id IN (${projectIds.map(() => '?').join(', ')})`,
          ...projectIds
        )
  return Number(row?.['total'] ?? 0)
}

function mapDevice(row: SqlRow): DeviceDto {
  return {
    projectId: String(row['project_id']),
    deviceId: String(row['device_id']),
    registeredAt: String(row['registered_at']),
    locked: Number(row['locked']) === 1,
    lockedAt: row['locked_at'] === null ? null : String(row['locked_at']),
    unbindAt: row['unbind_at'] === null ? null : String(row['unbind_at'])
  }
}

/* --------------------------------- licenses ---------------------------------- */

export interface LicenseRecord extends LicenseDto {}

export function insertLicense(database: SqliteDatabase, license: LicenseDto): void {
  runStatement(
    database,
    `INSERT INTO licenses (
      license_id, project_id, device_id, control_license_id, issued_at, expires_at,
      status, payload_sha256, file_name, file_state, created_at, superseded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    license.licenseId,
    license.projectId,
    license.deviceId,
    license.controlLicenseId,
    license.issuedAt,
    license.expiresAt,
    license.status,
    license.payloadSha256,
    license.fileName,
    license.fileState,
    license.issuedAt,
    license.supersededBy
  )
}

export function markLicenseFileState(
  database: SqliteDatabase,
  licenseId: string,
  fileState: LicenseFileState
): void {
  runStatement(database, 'UPDATE licenses SET file_state = ? WHERE license_id = ?', fileState, licenseId)
}

export function deleteLicense(database: SqliteDatabase, licenseId: string): void {
  runStatement(database, 'DELETE FROM licenses WHERE license_id = ?', licenseId)
}

export function setLicenseStatus(database: SqliteDatabase, licenseId: string, status: LicenseStatus): void {
  runStatement(database, 'UPDATE licenses SET status = ? WHERE license_id = ?', status, licenseId)
}

export function setSupersededBy(database: SqliteDatabase, licenseId: string, supersededBy: string): void {
  runStatement(database, 'UPDATE licenses SET superseded_by = ? WHERE license_id = ?', supersededBy, licenseId)
}

export function findLicense(database: SqliteDatabase, licenseId: string): LicenseDto | null {
  const row = getOne(database, 'SELECT * FROM licenses WHERE license_id = ?', licenseId)
  return row === null ? null : mapLicense(row)
}

/** 设备当前授权：已写入文件、状态 active、未被续期替代的最新一条 */
export function findCurrentLicense(
  database: SqliteDatabase,
  projectId: string,
  deviceId: string
): LicenseDto | null {
  const row = getOne(
    database,
    `SELECT * FROM licenses
     WHERE project_id = ? AND device_id = ? AND status = 'active' AND file_state = 'written' AND superseded_by IS NULL
     ORDER BY rowid DESC LIMIT 1`,
    projectId,
    deviceId
  )
  return row === null ? null : mapLicense(row)
}

export function listLicenses(
  database: SqliteDatabase,
  options: { readonly projectId?: string; readonly deviceId?: string; readonly limit?: number } = {}
): LicenseDto[] {
  const conditions: string[] = []
  const params: string[] = []
  if (options.projectId !== undefined) {
    conditions.push('project_id = ?')
    params.push(options.projectId)
  }
  if (options.deviceId !== undefined) {
    conditions.push('device_id = ?')
    params.push(options.deviceId)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = options.limit ?? 200
  return getAll(
    database,
    `SELECT * FROM licenses ${where} ORDER BY issued_at DESC, license_id DESC LIMIT ${Math.max(1, Math.min(limit, 1000))}`,
    ...params
  ).map(mapLicense)
}

export function listPendingLicenses(database: SqliteDatabase): LicenseDto[] {
  return getAll(database, `SELECT * FROM licenses WHERE file_state = 'pending'`).map(mapLicense)
}

export function listAllLicenseFileNames(database: SqliteDatabase): string[] {
  return getAll(database, 'SELECT file_name FROM licenses').map((row) => String(row['file_name']))
}

function mapLicense(row: SqlRow): LicenseDto {
  return {
    licenseId: String(row['license_id']),
    projectId: String(row['project_id']),
    deviceId: String(row['device_id']),
    controlLicenseId: String(row['control_license_id']),
    issuedAt: String(row['issued_at']),
    expiresAt: String(row['expires_at']),
    status: String(row['status']) as LicenseStatus,
    payloadSha256: String(row['payload_sha256']),
    fileName: String(row['file_name']),
    fileState: String(row['file_state']) as LicenseFileState,
    supersededBy: row['superseded_by'] === null ? null : String(row['superseded_by'])
  }
}

/* ------------------------------ control certificates ------------------------- */

export interface ControlCertificateRecord extends ControlCertificateDto {
  readonly envelope: string
}

export function saveControlCertificate(
  database: SqliteDatabase,
  record: ControlCertificateRecord
): void {
  runStatement(database, 'UPDATE control_certificates SET is_active = 0 WHERE is_active = 1')
  const existing = getOne(database, 'SELECT license_id FROM control_certificates WHERE license_id = ?', record.licenseId)
  if (existing === null) {
    runStatement(
      database,
      `INSERT INTO control_certificates (license_id, kid, envelope, issued_at, expires_at, imported_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      record.licenseId,
      record.kid,
      record.envelope,
      record.issuedAt,
      record.expiresAt,
      record.importedAt
    )
    return
  }
  runStatement(
    database,
    `UPDATE control_certificates
     SET kid = ?, envelope = ?, issued_at = ?, expires_at = ?, imported_at = ?, is_active = 1
     WHERE license_id = ?`,
    record.kid,
    record.envelope,
    record.issuedAt,
    record.expiresAt,
    record.importedAt,
    record.licenseId
  )
}

export function findActiveControlCertificate(database: SqliteDatabase): ControlCertificateRecord | null {
  const row = getOne(database, 'SELECT * FROM control_certificates WHERE is_active = 1')
  return row === null ? null : mapControlCertificate(row)
}

export function findControlCertificateById(
  database: SqliteDatabase,
  licenseId: string
): ControlCertificateRecord | null {
  const row = getOne(database, 'SELECT * FROM control_certificates WHERE license_id = ?', licenseId)
  return row === null ? null : mapControlCertificate(row)
}

function mapControlCertificate(row: SqlRow): ControlCertificateRecord {
  return {
    licenseId: String(row['license_id']),
    kid: String(row['kid']),
    envelope: String(row['envelope']),
    issuedAt: String(row['issued_at']),
    expiresAt: String(row['expires_at']),
    importedAt: String(row['imported_at']),
    isActive: Number(row['is_active']) === 1,
    // 以下三项不属于数据库列，由服务层从 payload 填充
    projectIds: [],
    maxDevices: 0,
    features: []
  }
}

/* ----------------------------------- audit ----------------------------------- */

export interface AuditEntry {
  readonly at: string
  readonly actor: string
  readonly action: string
  readonly targetType: string
  readonly targetId: string
  readonly result: 'success' | 'failure'
  readonly errorCode: string | null
  /** 已脱敏的上下文 JSON 文本，禁止写入私钥或完整授权文件内容 */
  readonly context: string | null
}

export function appendAuditLog(database: SqliteDatabase, entry: AuditEntry): void {
  runStatement(
    database,
    'INSERT INTO audit_logs (at, actor, action, target_type, target_id, result, error_code, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    entry.at,
    entry.actor,
    entry.action,
    entry.targetType,
    entry.targetId,
    entry.result,
    entry.errorCode,
    entry.context
  )
}

export function listAuditLogs(
  database: SqliteDatabase,
  options: { readonly limit?: number; readonly targetId?: string; readonly action?: string } = {}
): AuditLogDto[] {
  const conditions: string[] = []
  const params: string[] = []
  if (options.targetId !== undefined) {
    conditions.push('target_id = ?')
    params.push(options.targetId)
  }
  if (options.action !== undefined) {
    conditions.push('action = ?')
    params.push(options.action)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000))
  return getAll(
    database,
    `SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ${limit}`,
    ...params
  ).map((row) => ({
    id: Number(row['id']),
    at: String(row['at']),
    actor: String(row['actor']),
    action: String(row['action']),
    targetType: String(row['target_type']),
    targetId: String(row['target_id']),
    result: String(row['result']) as 'success' | 'failure',
    errorCode: row['error_code'] === null ? null : String(row['error_code']),
    context: row['context'] === null ? null : String(row['context'])
  }))
}

/* ---------------------------------- settings --------------------------------- */

export function getSetting(database: SqliteDatabase, key: string): string | null {
  const row = getOne(database, 'SELECT value FROM app_settings WHERE key = ?', key)
  return row === null ? null : String(row['value'])
}

export function setSetting(database: SqliteDatabase, key: string, value: string, updatedAt: string): void {
  runStatement(
    database,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    updatedAt
  )
}
