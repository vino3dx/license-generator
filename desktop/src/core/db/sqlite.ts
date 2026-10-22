import { DatabaseSync } from 'node:sqlite'

export type SqliteDatabase = DatabaseSync
export type SqlValue = string | number | null
/** 仓储返回的原始行 */
export type SqlRow = Record<string, SqlValue>

/**
 * 打开数据库并设置连接级 PRAGMA。
 * 使用 Electron 内置的 node:sqlite，避免原生模块与 electron-rebuild。
 */
export function openSqliteDatabase(file: string): SqliteDatabase {
  const database = new DatabaseSync(file)
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA busy_timeout = 5000')
  if (file !== ':memory:') {
    database.exec('PRAGMA journal_mode = WAL')
  }
  return database
}

const depths = new WeakMap<SqliteDatabase, number>()

/**
 * 事务包装：顶层用 BEGIN IMMEDIATE，嵌套用 SAVEPOINT。
 * 只包装数据库操作；文件系统操作不能放进这里当成可回滚的。
 */
export function withTransaction<T>(database: SqliteDatabase, work: () => T): T {
  const depth = depths.get(database) ?? 0
  const savepoint = `sp_${depth}`
  if (depth === 0) {
    database.exec('BEGIN IMMEDIATE')
  } else {
    database.exec(`SAVEPOINT ${savepoint}`)
  }
  depths.set(database, depth + 1)
  try {
    const result = work()
    if (depth === 0) {
      database.exec('COMMIT')
    } else {
      database.exec(`RELEASE ${savepoint}`)
    }
    return result
  } catch (error) {
    if (depth === 0) {
      database.exec('ROLLBACK')
    } else {
      database.exec(`ROLLBACK TO ${savepoint}`)
      database.exec(`RELEASE ${savepoint}`)
    }
    throw error
  } finally {
    depths.set(database, depth)
  }
}

export function getOne(database: SqliteDatabase, sql: string, ...params: SqlValue[]): SqlRow | null {
  const row = database.prepare(sql).get(...params)
  return row === undefined ? null : (row as SqlRow)
}

export function getAll(database: SqliteDatabase, sql: string, ...params: SqlValue[]): SqlRow[] {
  return database.prepare(sql).all(...params) as SqlRow[]
}

export function runStatement(database: SqliteDatabase, sql: string, ...params: SqlValue[]): void {
  database.prepare(sql).run(...params)
}
