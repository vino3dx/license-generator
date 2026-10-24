import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDatabase,
  LATEST_SCHEMA_VERSION,
  currentSchemaVersion,
  getSetting,
  insertDeliveryOrder,
  openSqliteDatabase,
  setSetting,
  type SqliteDatabase
} from '@core/db'
import { MIGRATIONS } from '@core/db/migrations'
import type { DeliveryOrderDto } from '@shared/license/delivery-contract'
import { createHarness } from '../services/harness'

const tempDirs: string[] = []

function tempDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-db-'))
  tempDirs.push(dir)
  return join(dir, 'aegis.sqlite')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 下 WAL 句柄可能延迟释放；临时目录由系统清理，不影响断言
    }
  }
})

describe('数据库迁移', () => {
  it('全新数据库会应用全部迁移并记录版本', () => {
    const { database, migration } = createDatabase(':memory:')
    expect(migration.appliedVersions).toEqual([1, 2, 3])
    expect(migration.currentVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(currentSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
    database.close()
  })

  it('重复打开不会重复执行迁移', () => {
    const file = tempDbFile()
    const first = createDatabase(file)
    expect(first.migration.appliedVersions).toEqual([1, 2, 3])
    first.database.close()

    const second = createDatabase(file)
    expect(second.migration.appliedVersions).toEqual([])
    expect(second.migration.currentVersion).toBe(LATEST_SCHEMA_VERSION)
    second.database.close()
  })

  it('重启后数据仍在（文件持久化）', () => {
    const file = tempDbFile()
    const first = createDatabase(file).database
    first.exec(
      "INSERT INTO projects (project_id, name, status, created_at) VALUES ('proj-a', '项目 A', 'active', '2026-10-22T00:00:00Z')"
    )
    setSetting(first, 'licenses.dir_version', '1', '2026-10-22T00:00:00Z')
    first.close()

    const second = createDatabase(file).database
    const row = second.prepare('SELECT name FROM projects WHERE project_id = ?').get('proj-a') as
      | { name: string }
      | undefined
    expect(row?.name).toBe('项目 A')
    expect(getSetting(second, 'licenses.dir_version')).toBe('1')
    second.close()
  })
})

describe('数据约束', () => {
  it('外键与唯一约束生效', () => {
    const { database } = createDatabase(':memory:')
    expect(() =>
      database.exec(
        "INSERT INTO devices (project_id, device_id, registered_at) VALUES ('missing', 'dev-1', '2026-10-22T00:00:00Z')"
      )
    ).toThrow()

    database.exec(
      "INSERT INTO projects (project_id, name, status, created_at) VALUES ('proj-a', 'A', 'active', '2026-10-22T00:00:00Z')"
    )
    database.exec(
      "INSERT INTO projects (project_id, name, status, created_at) VALUES ('proj-b', 'B', 'active', '2026-10-22T00:00:00Z')"
    )

    expect(() =>
      database.exec(
        "INSERT INTO projects (project_id, name, status, created_at) VALUES ('proj-a', 'A2', 'active', '2026-10-22T00:00:00Z')"
      )
    ).toThrow()

    database.exec(
      "INSERT INTO devices (project_id, device_id, registered_at) VALUES ('proj-a', 'dev-1', '2026-10-22T00:00:00Z')"
    )
    // 同一设备不能在另一个项目里同时保持未解绑
    expect(() =>
      database.exec(
        "INSERT INTO devices (project_id, device_id, registered_at) VALUES ('proj-b', 'dev-1', '2026-10-22T00:00:00Z')"
      )
    ).toThrow()

    // 解绑后可以重新占用（同一项目内更新，另一项目可新建记录）
    database.exec("UPDATE devices SET unbind_at = '2026-10-22T01:00:00Z' WHERE project_id = 'proj-a'")
    expect(() =>
      database.exec(
        "INSERT INTO devices (project_id, device_id, registered_at) VALUES ('proj-b', 'dev-1', '2026-10-22T00:00:00Z')"
      )
    ).not.toThrow()

    // 授权必须挂在已登记设备上
    expect(() =>
      database.exec(
        `INSERT INTO licenses (license_id, project_id, device_id, control_license_id, issued_at, expires_at,
          status, payload_sha256, file_name, file_state, created_at)
         VALUES ('lic-1', 'proj-b', 'dev-x', 'ctl-1', '2026-10-22T00:00:00Z', '2027-01-01T00:00:00Z',
          'active', 'hash', 'lic-1.json', 'pending', '2026-10-22T00:00:00Z')`
      )
    ).toThrow()

    database.close()
  })

  it('同一时刻只能有一张生效的中控证书', () => {
    const { database } = createDatabase(':memory:')
    const insert = (id: string, active: number): void => {
      database.exec(
        `INSERT INTO control_certificates (license_id, kid, envelope, issued_at, expires_at, imported_at, is_active)
         VALUES ('${id}', 'kid', '{}', '2026-10-01T00:00:00Z', '2027-10-01T00:00:00Z', '2026-10-22T00:00:00Z', ${active})`
      )
    }
    insert('ctl-1', 1)
    expect(() => insert('ctl-2', 1)).toThrow()
    expect(() => insert('ctl-2', 0)).not.toThrow()
    database.close()
  })

  it('状态字段受限', () => {
    const { database } = createDatabase(':memory:')
    expect(() =>
      database.exec(
        "INSERT INTO projects (project_id, name, status, created_at) VALUES ('p', 'n', 'unknown', '2026-10-22T00:00:00Z')"
      )
    ).toThrow()
    database.close()
  })
})

/** 构造某个历史版本的数据库（只应用 <= version 的迁移），用于验证升级路径 */
function createSchemaAt(version: number, file: string): SqliteDatabase {
  const database = openSqliteDatabase(file)
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, name TEXT NOT NULL)`
  )
  for (const migration of MIGRATIONS.filter((item) => item.version <= version)) {
    for (const statement of migration.statements) {
      database.exec(statement)
    }
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at, name) VALUES (?, ?, ?)')
      .run(migration.version, '2026-10-20T00:00:00Z', migration.name)
  }
  return database
}

function orderOf(overrides: Partial<DeliveryOrderDto> = {}): DeliveryOrderDto {
  return {
    orderId: 'ord-1',
    kind: 'issue',
    state: 'generated',
    licenseId: 'MCH-1',
    projectId: 'proj-a',
    deviceId: 'dev-1',
    controlLicenseId: 'VND-1',
    expiresAt: '2027-01-01T00:00:00Z',
    attempts: 0,
    lastError: null,
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
    sentAt: null,
    confirmedAt: null,
    requestedBy: 'tester',
    ...overrides
  }
}

describe('v2 升级到 v3', () => {
  it('只追加应用 v3，保留既有项目/设备/授权/审计数据', () => {
    const file = tempDbFile()
    const legacy = createSchemaAt(2, file)
    expect(currentSchemaVersion(legacy)).toBe(2)
    legacy.exec(
      "INSERT INTO projects (project_id, name, status, created_at) VALUES ('proj-a', '客户 A', 'active', '2026-10-20T00:00:00Z')"
    )
    legacy.exec(
      "INSERT INTO devices (project_id, device_id, registered_at) VALUES ('proj-a', 'dev-1', '2026-10-20T00:00:00Z')"
    )
    legacy.exec(
      `INSERT INTO control_certificates (license_id, kid, envelope, issued_at, expires_at, imported_at, is_active)
       VALUES ('ctl-1', 'kid', '{}', '2026-10-01T00:00:00Z', '2027-10-01T00:00:00Z', '2026-10-20T00:00:00Z', 1)`
    )
    legacy.exec(
      `INSERT INTO licenses (license_id, project_id, device_id, control_license_id, issued_at, expires_at,
         status, payload_sha256, file_name, file_state, created_at)
       VALUES ('MCH-OLD', 'proj-a', 'dev-1', 'ctl-1', '2026-10-20T00:00:00Z', '2027-01-01T00:00:00Z',
         'active', 'hash', 'MCH-OLD.json', 'written', '2026-10-20T00:00:00Z')`
    )
    legacy.exec(
      "INSERT INTO audit_logs (at, action, target_type, target_id, result, error_code, context) VALUES ('2026-10-20T00:00:00Z', 'license_issue', 'license', 'MCH-OLD', 'success', NULL, NULL)"
    )
    legacy.close()

    const upgraded = createDatabase(file)
    expect(upgraded.migration.appliedVersions).toEqual([3])
    expect(upgraded.migration.currentVersion).toBe(3)
    const database = upgraded.database

    const license = database.prepare("SELECT file_state FROM licenses WHERE license_id = 'MCH-OLD'").get() as
      | { file_state: string }
      | undefined
    expect(license?.file_state).toBe('written')
    const audit = database.prepare("SELECT actor, action FROM audit_logs WHERE target_id = 'MCH-OLD'").get() as
      | { actor: string; action: string }
      | undefined
    expect(audit?.action).toBe('license_issue')
    expect(audit?.actor).toBe('local-console')

    // 新表存在且可写
    database.exec(
      "INSERT INTO device_meta (project_id, device_id, label, updated_at) VALUES ('proj-a', 'dev-1', '展厅主机', '2026-10-24T00:00:00Z')"
    )
    const meta = database.prepare("SELECT label FROM device_meta WHERE device_id = 'dev-1'").get() as
      | { label: string }
      | undefined
    expect(meta?.label).toBe('展厅主机')
    database.close()
  })

  it('升级后既有签发、查询与对账仍然可用', () => {
    const file = tempDbFile()
    const legacy = createSchemaAt(2, file)
    legacy.exec(
      "INSERT INTO projects (project_id, name, status, created_at) VALUES ('proj-a', '客户 A', 'active', '2026-10-20T00:00:00Z')"
    )
    legacy.exec(
      "INSERT INTO devices (project_id, device_id, registered_at) VALUES ('proj-a', 'dev-1', '2026-10-20T00:00:00Z')"
    )
    legacy.close()

    const { database } = createDatabase(file)
    const harness = createHarness({ database, databaseFile: file })
    try {
      harness.services.control.importCertificate(harness.controlEnvelope())
      const issued = harness.services.licensing.issue({ projectId: 'proj-a', deviceId: 'dev-1' })
      expect(issued.fileState).toBe('written')
      expect(issued.projectId).toBe('proj-a')

      const status = harness.services.devices.status({ projectId: 'proj-a', deviceId: 'dev-1' })
      expect(status.license?.licenseId).toBe(issued.licenseId)
      expect(status.file.ok).toBe(true)

      expect(harness.services.maintenance.reconcile().pendingRolledBack).toBe(0)
      expect(harness.services.licensing.list({ projectId: 'proj-a' })).toHaveLength(1)
    } finally {
      harness.cleanup()
    }
  })
})

describe('派发订单结构约束', () => {
  function freshDb(): SqliteDatabase {
    const { database } = createDatabase(':memory:')
    database.exec(
      "INSERT INTO projects (project_id, name, status, created_at) VALUES ('proj-a', 'A', 'active', '2026-10-24T00:00:00Z')"
    )
    database.exec(
      "INSERT INTO devices (project_id, device_id, registered_at) VALUES ('proj-a', 'dev-1', '2026-10-24T00:00:00Z')"
    )
    return database
  }

  it('同一设备/类型/到期时间只允许一条进行中订单（幂等），失败后允许重试新订单', () => {
    const database = freshDb()
    insertDeliveryOrder(database, orderOf())

    // 重复派发：同一幂等键再次插入必须被拒绝（服务层应先查 findActiveDeliveryOrder 复用）
    expect(() => insertDeliveryOrder(database, orderOf({ orderId: 'ord-2', licenseId: 'MCH-2' }))).toThrow()

    // 失败之后允许插入新订单作为重试
    database.exec("UPDATE delivery_orders SET state = 'failed' WHERE order_id = 'ord-1'")
    expect(() =>
      insertDeliveryOrder(database, orderOf({ orderId: 'ord-2', licenseId: 'MCH-2', state: 'queued' }))
    ).not.toThrow()

    // 已确认的订单同样占用幂等键，避免重复签发同一期限
    database.exec("UPDATE delivery_orders SET state = 'confirmed' WHERE order_id = 'ord-2'")
    expect(() => insertDeliveryOrder(database, orderOf({ orderId: 'ord-3', state: 'generated' }))).toThrow()
    database.close()
  })

  it('订单状态只能是枚举值，且必须挂在已登记设备上', () => {
    const database = freshDb()
    expect(() =>
      database.exec(
        `INSERT INTO delivery_orders (order_id, kind, state, license_id, project_id, device_id, control_license_id,
           expires_at, created_at, updated_at, requested_by)
         VALUES ('ord-bad', 'issue', 'installed', 'MCH-1', 'proj-a', 'dev-1', 'VND-1',
           '2027-01-01T00:00:00Z', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z', 'tester')`
      )
    ).toThrow()

    expect(() =>
      database.exec(
        `INSERT INTO delivery_orders (order_id, kind, state, license_id, project_id, device_id, control_license_id,
           expires_at, created_at, updated_at, requested_by)
         VALUES ('ord-ghost', 'issue', 'generated', 'MCH-1', 'proj-a', 'dev-x', 'VND-1',
           '2027-01-01T00:00:00Z', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z', 'tester')`
      )
    ).toThrow()
    database.close()
  })

  it('设备元数据必须挂在已登记设备上，并随设备记录级联删除', () => {
    const database = freshDb()
    expect(() =>
      database.exec(
        "INSERT INTO device_meta (project_id, device_id, label, updated_at) VALUES ('proj-a', 'dev-x', '幽灵', '2026-10-24T00:00:00Z')"
      )
    ).toThrow()

    database.exec(
      "INSERT INTO device_meta (project_id, device_id, label, updated_at) VALUES ('proj-a', 'dev-1', '展厅主机', '2026-10-24T00:00:00Z')"
    )
    database.exec("DELETE FROM devices WHERE device_id = 'dev-1'")
    const row = database.prepare("SELECT COUNT(1) AS total FROM device_meta WHERE device_id = 'dev-1'").get() as
      | { total: number }
      | undefined
    expect(Number(row?.total)).toBe(0)
    database.close()
  })

  it('设备通信记录允许未知设备（被拒请求也要留证），但订单外键必须有效', () => {
    const database = freshDb()
    database.exec(
      `INSERT INTO device_requests (at, project_id, device_id, ip, kind, result, reason)
       VALUES ('2026-10-24T00:00:00Z', 'proj-a', 'dev-unknown', '192.168.1.9', 'pull', 'denied', 'device_not_registered')`
    )
    const row = database
      .prepare("SELECT COUNT(1) AS total FROM device_requests WHERE device_id = 'dev-unknown'")
      .get() as { total: number } | undefined
    expect(Number(row?.total)).toBe(1)

    expect(() =>
      database.exec(
        `INSERT INTO device_requests (at, project_id, device_id, ip, kind, result, order_id)
         VALUES ('2026-10-24T00:00:00Z', 'proj-a', 'dev-1', '127.0.0.1', 'pull', 'issued', 'ord-missing')`
      )
    ).toThrow()
    database.close()
  })
})
