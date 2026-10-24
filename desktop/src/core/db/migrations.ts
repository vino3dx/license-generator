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
  },
  {
    version: 3,
    name: 'delivery_and_device_meta',
    statements: [
      // 设备展示与通信元数据：不改 devices 表，身份仍以 (project_id, device_id) 为准
      `CREATE TABLE device_meta (
        project_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        last_ip TEXT,
        last_seen_at TEXT,
        last_pull_result TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, device_id),
        FOREIGN KEY (project_id, device_id) REFERENCES devices(project_id, device_id) ON DELETE CASCADE
      )`,
      'CREATE INDEX device_meta_seen ON device_meta(last_seen_at DESC)',
      /*
       * 派发订单：表达"中控已生成 → 已入队 → 已发送 → 子机自报确认"的真实进度。
       * license_id 指向 licenses.license_id，但不设物理外键：
       * 授权对账（reconcile）回滚 pending 记录时不能因为历史订单而被阻塞。
       * devices 外键用 RESTRICT：订单是审计性数据，不允许因设备记录被删除而丢失。
       */
      `CREATE TABLE delivery_orders (
        order_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('issue', 'renew', 'revoke')),
        state TEXT NOT NULL CHECK (
          state IN ('generated', 'queued', 'sent', 'confirmed', 'failed', 'timeout', 'denied', 'unsupported')
        ),
        license_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        control_license_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        confirmed_at TEXT,
        requested_by TEXT NOT NULL,
        FOREIGN KEY (project_id, device_id) REFERENCES devices(project_id, device_id) ON DELETE RESTRICT
      )`,
      /*
       * 幂等规则：同一设备、同一订单类型、同一到期时间，只允许存在一条"进行中"的订单。
       * 重复派发请求必须复用该订单（不重复签发）；失败/超时/被拒之后才允许插入新订单作为重试。
       * 该部分索引的活跃集合必须与 DELIVERY_ACTIVE_STATES 保持一致（有测试校验）。
       */
      `CREATE UNIQUE INDEX delivery_orders_active_unique
        ON delivery_orders(project_id, device_id, kind, expires_at)
        WHERE state IN ('generated', 'queued', 'sent', 'confirmed')`,
      'CREATE INDEX delivery_orders_device ON delivery_orders(project_id, device_id, created_at DESC)',
      'CREATE INDEX delivery_orders_state ON delivery_orders(state, created_at DESC)',
      'CREATE INDEX delivery_orders_license ON delivery_orders(license_id)',
      /*
       * 设备通信原始记录。不设 devices 外键：未登记/未授权设备的请求也必须留证，
       * 否则无法解释"为什么设备没拿到授权"。
       */
      `CREATE TABLE device_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        project_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        ip TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('discover', 'pull')),
        current_license_id TEXT,
        current_expires_at TEXT,
        result TEXT NOT NULL,
        reason TEXT,
        order_id TEXT REFERENCES delivery_orders(order_id) ON DELETE SET NULL
      )`,
      'CREATE INDEX device_requests_device ON device_requests(project_id, device_id, at DESC)',
      'CREATE INDEX device_requests_at ON device_requests(at DESC)'
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
