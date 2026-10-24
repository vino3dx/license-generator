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
import type {
  DeliveryKind,
  DeliveryOrderDto,
  DeliveryState,
  DeviceMetaDto,
  DeviceRequestDto,
  DeviceRequestKind
} from '@shared/license/delivery-contract'
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

/**
 * 最近导入的一张证书（不论是否作废）。
 * 一次性证书规则下，签发成功后证书被置为 inactive；界面需要据此提示"证书已作废"。
 */
export function findLatestControlCertificate(database: SqliteDatabase): ControlCertificateRecord | null {
  const row = getOne(database, 'SELECT * FROM control_certificates ORDER BY imported_at DESC, rowid DESC LIMIT 1')
  return row === null ? null : mapControlCertificate(row)
}

/** 证书一次性规则：签发成功后置为 inactive，后续签发必须导入新证书 */
export function deactivateControlCertificate(database: SqliteDatabase, licenseId: string): void {
  runStatement(database, 'UPDATE control_certificates SET is_active = 0 WHERE license_id = ?', licenseId)
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

/* -------------------------------- device meta -------------------------------- */

export function getDeviceMeta(
  database: SqliteDatabase,
  projectId: string,
  deviceId: string
): DeviceMetaDto | null {
  const row = getOne(
    database,
    'SELECT * FROM device_meta WHERE project_id = ? AND device_id = ?',
    projectId,
    deviceId
  )
  return row === null ? null : mapDeviceMeta(row)
}

/** 写入或更新设备展示/通信元数据（不触碰 devices 本身） */
export function upsertDeviceMeta(database: SqliteDatabase, meta: DeviceMetaDto): void {
  runStatement(
    database,
    `INSERT INTO device_meta (project_id, device_id, label, last_ip, last_seen_at, last_pull_result, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, device_id) DO UPDATE SET
       label = excluded.label,
       last_ip = excluded.last_ip,
       last_seen_at = excluded.last_seen_at,
       last_pull_result = excluded.last_pull_result,
       updated_at = excluded.updated_at`,
    meta.projectId,
    meta.deviceId,
    meta.label,
    meta.lastIp,
    meta.lastSeenAt,
    meta.lastPullResult,
    meta.updatedAt
  )
}

export function listDeviceMeta(
  database: SqliteDatabase,
  options: { readonly projectId?: string } = {}
): DeviceMetaDto[] {
  const where = options.projectId === undefined ? '' : 'WHERE project_id = ?'
  const params = options.projectId === undefined ? [] : [options.projectId]
  return getAll(database, `SELECT * FROM device_meta ${where} ORDER BY project_id ASC, device_id ASC`, ...params).map(
    mapDeviceMeta
  )
}

function mapDeviceMeta(row: SqlRow): DeviceMetaDto {
  return {
    projectId: String(row['project_id']),
    deviceId: String(row['device_id']),
    label: String(row['label']),
    lastIp: row['last_ip'] === null ? null : String(row['last_ip']),
    lastSeenAt: row['last_seen_at'] === null ? null : String(row['last_seen_at']),
    lastPullResult: row['last_pull_result'] === null ? null : String(row['last_pull_result']),
    updatedAt: String(row['updated_at'])
  }
}

/* ------------------------------ delivery orders ------------------------------ */

export function insertDeliveryOrder(database: SqliteDatabase, order: DeliveryOrderDto): void {
  runStatement(
    database,
    `INSERT INTO delivery_orders (
       order_id, kind, state, license_id, project_id, device_id, control_license_id, expires_at,
       attempts, last_error, created_at, updated_at, sent_at, confirmed_at, requested_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    order.orderId,
    order.kind,
    order.state,
    order.licenseId,
    order.projectId,
    order.deviceId,
    order.controlLicenseId,
    order.expiresAt,
    order.attempts,
    order.lastError,
    order.createdAt,
    order.updatedAt,
    order.sentAt,
    order.confirmedAt,
    order.requestedBy
  )
}

export function findDeliveryOrder(database: SqliteDatabase, orderId: string): DeliveryOrderDto | null {
  const row = getOne(database, 'SELECT * FROM delivery_orders WHERE order_id = ?', orderId)
  return row === null ? null : mapDeliveryOrder(row)
}

/**
 * 幂等查询：同一设备 + 同一类型 + 同一到期时间的"进行中"订单（含已确认）。
 * 与 delivery_orders_active_unique 部分唯一索引使用同一组字段，保证不会重复签发。
 */
export function findActiveDeliveryOrder(
  database: SqliteDatabase,
  input: {
    readonly projectId: string
    readonly deviceId: string
    readonly kind: DeliveryKind
    readonly expiresAt: string
  }
): DeliveryOrderDto | null {
  const row = getOne(
    database,
    `SELECT * FROM delivery_orders
     WHERE project_id = ? AND device_id = ? AND kind = ? AND expires_at = ?
       AND state IN ('generated', 'queued', 'sent', 'confirmed')
     ORDER BY created_at DESC LIMIT 1`,
    input.projectId,
    input.deviceId,
    input.kind,
    input.expiresAt
  )
  return row === null ? null : mapDeliveryOrder(row)
}

export interface DeliveryStateUpdate {
  readonly orderId: string
  readonly state: DeliveryState
  readonly at: string
  readonly lastError: string | null
  /** 只写一次：已有值不会被空值覆盖 */
  readonly sentAt?: string | null
  /** 只写一次：已有值不会被空值覆盖 */
  readonly confirmedAt?: string | null
}

/** 状态写入；转换合法性由业务层 assertDeliveryTransition 保证，仓储不做业务判断 */
export function updateDeliveryOrderState(database: SqliteDatabase, update: DeliveryStateUpdate): void {
  runStatement(
    database,
    `UPDATE delivery_orders
     SET state = ?, last_error = ?, updated_at = ?,
         sent_at = COALESCE(?, sent_at),
         confirmed_at = COALESCE(?, confirmed_at)
     WHERE order_id = ?`,
    update.state,
    update.lastError,
    update.at,
    update.sentAt ?? null,
    update.confirmedAt ?? null,
    update.orderId
  )
}

export function incrementDeliveryAttempts(database: SqliteDatabase, orderId: string, at: string): void {
  runStatement(
    database,
    'UPDATE delivery_orders SET attempts = attempts + 1, updated_at = ? WHERE order_id = ?',
    at,
    orderId
  )
}

export function listDeliveryOrders(
  database: SqliteDatabase,
  options: {
    readonly projectId?: string
    readonly deviceId?: string
    readonly state?: DeliveryState
    readonly limit?: number
  } = {}
): DeliveryOrderDto[] {
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
  if (options.state !== undefined) {
    conditions.push('state = ?')
    params.push(options.state)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000))
  return getAll(
    database,
    `SELECT * FROM delivery_orders ${where} ORDER BY created_at DESC, order_id DESC LIMIT ${limit}`,
    ...params
  ).map(mapDeliveryOrder)
}

function mapDeliveryOrder(row: SqlRow): DeliveryOrderDto {
  return {
    orderId: String(row['order_id']),
    kind: String(row['kind']) as DeliveryKind,
    state: String(row['state']) as DeliveryState,
    licenseId: String(row['license_id']),
    projectId: String(row['project_id']),
    deviceId: String(row['device_id']),
    controlLicenseId: String(row['control_license_id']),
    expiresAt: String(row['expires_at']),
    attempts: Number(row['attempts']),
    lastError: row['last_error'] === null ? null : String(row['last_error']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    sentAt: row['sent_at'] === null ? null : String(row['sent_at']),
    confirmedAt: row['confirmed_at'] === null ? null : String(row['confirmed_at']),
    requestedBy: String(row['requested_by'])
  }
}

/* ------------------------------ device requests ------------------------------ */

export interface DeviceRequestInput {
  readonly at: string
  readonly projectId: string
  readonly deviceId: string
  readonly ip: string | null
  readonly kind: DeviceRequestKind
  readonly currentLicenseId: string | null
  readonly currentExpiresAt: string | null
  readonly result: string
  readonly reason: string | null
  readonly orderId: string | null
}

/** 追加一条通信记录，返回自增 id */
export function appendDeviceRequest(database: SqliteDatabase, input: DeviceRequestInput): number {
  const result = database
    .prepare(
      `INSERT INTO device_requests (
         at, project_id, device_id, ip, kind, current_license_id, current_expires_at, result, reason, order_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.at,
      input.projectId,
      input.deviceId,
      input.ip,
      input.kind,
      input.currentLicenseId,
      input.currentExpiresAt,
      input.result,
      input.reason,
      input.orderId
    )
  return Number(result.lastInsertRowid)
}

export function listDeviceRequests(
  database: SqliteDatabase,
  options: {
    readonly projectId?: string
    readonly deviceId?: string
    readonly limit?: number
  } = {}
): DeviceRequestDto[] {
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
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000))
  return getAll(
    database,
    `SELECT * FROM device_requests ${where} ORDER BY id DESC LIMIT ${limit}`,
    ...params
  ).map((row) => ({
    id: Number(row['id']),
    at: String(row['at']),
    projectId: String(row['project_id']),
    deviceId: String(row['device_id']),
    ip: row['ip'] === null ? null : String(row['ip']),
    kind: String(row['kind']) as DeviceRequestKind,
    currentLicenseId: row['current_license_id'] === null ? null : String(row['current_license_id']),
    currentExpiresAt: row['current_expires_at'] === null ? null : String(row['current_expires_at']),
    result: String(row['result']),
    reason: row['reason'] === null ? null : String(row['reason']),
    orderId: row['order_id'] === null ? null : String(row['order_id'])
  }))
}
