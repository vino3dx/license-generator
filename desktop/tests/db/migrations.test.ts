import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, LATEST_SCHEMA_VERSION, currentSchemaVersion, getSetting, setSetting } from '@core/db'

const tempDirs: string[] = []

function tempDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-db-'))
  tempDirs.push(dir)
  return join(dir, 'aegis.sqlite')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('数据库迁移', () => {
  it('全新数据库会应用全部迁移并记录版本', () => {
    const { database, migration } = createDatabase(':memory:')
    expect(migration.appliedVersions).toEqual([1, 2])
    expect(migration.currentVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(currentSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
    database.close()
  })

  it('重复打开不会重复执行迁移', () => {
    const file = tempDbFile()
    const first = createDatabase(file)
    expect(first.migration.appliedVersions).toEqual([1, 2])
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
