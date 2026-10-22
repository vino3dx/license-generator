import { getAll, getOne, runStatement, withTransaction, type SqliteDatabase } from './sqlite'

export interface Migration {
  readonly version: number
  readonly name: string
  readonly statements: readonly string[]
}

/**
 * 版本化迁移：只允许追加，不允许修改已发布的迁移脚本。
 * 数据库不会保存任何私钥或授权文件内容，只保存授权文件的相对文件名与摘要。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    statements: [
      `CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE devices (
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        device_id TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
        locked_at TEXT,
        unbind_at TEXT,
        PRIMARY KEY (project_id, device_id)
      )`,
      // 同一台设备在任意项目内只能有一条未解绑记录，避免重复占用额度
      `CREATE UNIQUE INDEX devices_active_unique ON devices(device_id) WHERE unbind_at IS NULL`,
      `CREATE INDEX devices_project ON devices(project_id, unbind_at)`,
      `CREATE TABLE control_certificates (
        license_id TEXT PRIMARY KEY,
        kid TEXT NOT NULL,
        envelope TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
      )`,
      // 任意时刻最多一张生效的中控证书
      `CREATE UNIQUE INDEX control_certificates_active_unique ON control_certificates(is_active) WHERE is_active = 1`,
      `CREATE TABLE licenses (
        license_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        control_license_id TEXT NOT NULL REFERENCES control_certificates(license_id) ON DELETE RESTRICT,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        payload_sha256 TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_state TEXT NOT NULL CHECK (file_state IN ('pending', 'written')),
        created_at TEXT NOT NULL,
        superseded_by TEXT REFERENCES licenses(license_id) ON DELETE SET NULL,
        FOREIGN KEY (project_id, device_id) REFERENCES devices(project_id, device_id) ON DELETE RESTRICT
      )`,
      `CREATE INDEX licenses_device ON licenses(project_id, device_id, issued_at)`,
      `CREATE INDEX licenses_state ON licenses(file_state)`,
      `CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
        error_code TEXT,
        context TEXT
      )`,
      `CREATE INDEX audit_logs_at ON audit_logs(at DESC)`,
      `CREATE INDEX audit_logs_target ON audit_logs(target_type, target_id, at DESC)`,
      `CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ]
  },
  {
    version: 2,
    name: 'audit_actor',
    statements: [
      // 审计需要记录操作者；v1 已发布，按追加迁移处理
      `ALTER TABLE audit_logs ADD COLUMN actor TEXT NOT NULL DEFAULT 'local-console'`,
      'CREATE INDEX audit_logs_actor ON audit_logs(actor, at DESC)'
    ]
  }
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

export interface MigrationResult {
  readonly appliedVersions: readonly number[]
  readonly currentVersion: number
}

/** 幂等：只应用尚未记录的迁移，每个迁移单独一个事务 */
export function migrate(database: SqliteDatabase): MigrationResult {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    name TEXT NOT NULL
  )`)

  const appliedRows = getAll(database, 'SELECT version FROM schema_migrations')
  const applied = new Set(appliedRows.map((row) => Number(row['version'])))
  const appliedVersions: number[] = []

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue
    }
    withTransaction(database, () => {
      for (const statement of migration.statements) {
        database.exec(statement)
      }
      runStatement(
        database,
        'INSERT INTO schema_migrations (version, applied_at, name) VALUES (?, ?, ?)',
        migration.version,
        new Date().toISOString(),
        migration.name
      )
    })
    appliedVersions.push(migration.version)
  }

  return { appliedVersions, currentVersion: currentSchemaVersion(database) }
}

export function currentSchemaVersion(database: SqliteDatabase): number {
  const row = getOne(database, 'SELECT MAX(version) AS version FROM schema_migrations')
  const value = row?.['version']
  return value === null || value === undefined ? 0 : Number(value)
}
