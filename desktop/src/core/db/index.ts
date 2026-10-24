/**
 * 数据库模块（阶段 3）。
 *
 * 边界约定：
 * - 只由主进程调用，路径来自 app.getPath('userData')，不写入安装目录。
 * - 迁移版本化，启动时按序执行，禁止手工改表。
 * - 对上层只暴露仓储/事务接口，不把原始连接交给界面。
 */
import { migrate, type MigrationResult } from './migrations'
import { openSqliteDatabase, type SqliteDatabase } from './sqlite'

export interface OpenDatabaseResult {
  readonly database: SqliteDatabase
  readonly migration: MigrationResult
}

/** 打开数据库并确保迁移到最新版本（幂等） */
export function createDatabase(file: string): OpenDatabaseResult {
  const database = openSqliteDatabase(file)
  const migration = migrate(database)
  return { database, migration }
}

export { migrate, currentSchemaVersion, LATEST_SCHEMA_VERSION, type MigrationResult } from './migrations'
export { openSqliteDatabase, withTransaction, getOne, getAll, runStatement } from './sqlite'
export type { SqliteDatabase, SqlRow, SqlValue } from './sqlite'
export {
  appendAuditLog,
  appendDeviceRequest,
  countBoundDevices,
  deactivateControlCertificate,
  deleteLicense,
  findActiveControlCertificate,
  findActiveDeliveryOrder,
  findActiveDeviceById,
  findControlCertificateById,
  findCurrentLicense,
  findDeliveryOrder,
  findDevice,
  findLatestControlCertificate,
  findLicense,
  findProject,
  getDeviceMeta,
  getSetting,
  incrementDeliveryAttempts,
  insertDeliveryOrder,
  insertDevice,
  insertLicense,
  insertProject,
  listAllLicenseFileNames,
  listAuditLogs,
  listDeliveryOrders,
  listDeviceMeta,
  listDeviceRequests,
  listDevices,
  listLicenses,
  listPendingLicenses,
  listProjects,
  markLicenseFileState,
  saveControlCertificate,
  setLicenseStatus,
  setSetting,
  setSupersededBy,
  updateDeliveryOrderState,
  updateDeviceLock,
  updateDeviceRegistration,
  updateDeviceUnbind,
  updateProjectName,
  upsertDeviceMeta,
  type AuditEntry,
  type ControlCertificateRecord,
  type DeliveryStateUpdate,
  type DeviceRequestInput,
  type LicenseRecord
} from './repositories'
