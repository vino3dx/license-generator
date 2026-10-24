import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { getSetting, setSetting, type SqliteDatabase } from '@core/db'
import { ADMIN_PASSWORD_MIN_LENGTH } from '@shared/license/admin-contract'
import { ServiceError } from './errors'

/**
 * 管理员口令的存储与校验（主进程专用）。
 *
 * 设计：
 * - 只保存 scrypt 派生值 + 随机盐，不保存明文或可逆密文；
 * - 参数随记录保存，后续可以升级强度而不用重建凭据表；
 * - 失败计数持久化在 app_settings，重启后仍受限流约束；
 * - 本模块不产生任何返回值包含哈希，避免被日志/渲染进程带走。
 */
const CREDENTIAL_KEY = 'admin.credential'
const THROTTLE_KEY = 'admin.throttle'
const SALT_BYTES = 16
const KEY_BYTES = 32
/** scrypt 参数：N=2^15 在桌面端约 60~120ms，配合 maxmem 避免 Node 默认上限报错 */
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAXMEM = 96 * 1024 * 1024

interface CredentialRecord {
  readonly v: 1
  readonly algo: 'scrypt'
  readonly N: number
  readonly r: number
  readonly p: number
  readonly salt: string
  readonly hash: string
  readonly updatedAt: string
}

export interface ThrottleRecord {
  readonly failures: number
  /** ISO 时间；未锁定为 null */
  readonly lockedUntil: string | null
}

export interface ThrottlePolicy {
  readonly maxFailures: number
  readonly lockoutMs: number
}

export function isAdminConfigured(database: SqliteDatabase): boolean {
  return readCredential(database) !== null
}

/** 校验口令强度；不满足时抛 admin_password_weak（主进程强制，界面提示不构成边界） */
export function assertAdminPasswordPolicy(password: unknown): string {
  if (typeof password !== 'string') {
    throw new ServiceError('invalid_argument', '口令必须是字符串')
  }
  const value = password.trim()
  if (value.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new ServiceError('admin_password_weak', `管理员口令至少 ${ADMIN_PASSWORD_MIN_LENGTH} 个字符`)
  }
  if (password.length > 256) {
    throw new ServiceError('admin_password_weak', '管理员口令过长')
  }
  return password
}

/** 写入新口令（覆盖旧凭据）；调用方负责授权（必须已解锁或首次设置） */
export function writeAdminPassword(database: SqliteDatabase, password: string, at: string): void {
  const policyChecked = assertAdminPasswordPolicy(password)
  const salt = randomBytes(SALT_BYTES)
  const hash = derive(policyChecked, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
  const record: CredentialRecord = {
    v: 1,
    algo: 'scrypt',
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    updatedAt: at
  }
  setSetting(database, CREDENTIAL_KEY, JSON.stringify(record), at)
}

/** 校验口令；记录损坏/缺失一律返回 false（fail-closed） */
export function verifyAdminPassword(database: SqliteDatabase, password: unknown): boolean {
  if (typeof password !== 'string' || password.length === 0) {
    return false
  }
  const record = readCredential(database)
  if (record === null) {
    return false
  }
  try {
    const salt = Buffer.from(record.salt, 'base64')
    const expected = Buffer.from(record.hash, 'base64')
    if (salt.length === 0 || expected.length === 0) {
      return false
    }
    const actual = derive(password, salt, record.N, record.r, record.p)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export function readThrottle(database: SqliteDatabase): ThrottleRecord {
  const raw = getSetting(database, THROTTLE_KEY)
  if (raw === null) {
    return { failures: 0, lockedUntil: null }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ThrottleRecord>
    const failures = typeof parsed.failures === 'number' && Number.isFinite(parsed.failures) ? parsed.failures : 0
    const lockedUntil = typeof parsed.lockedUntil === 'string' ? parsed.lockedUntil : null
    return { failures: Math.max(0, Math.floor(failures)), lockedUntil }
  } catch {
    // 记录损坏不放大锁定，按无失败处理
    return { failures: 0, lockedUntil: null }
  }
}

/** 记录一次失败；达到上限时写入锁定到期时间 */
export function recordAdminFailure(
  database: SqliteDatabase,
  now: Date,
  policy: ThrottlePolicy
): ThrottleRecord {
  const current = readThrottle(database)
  const failures = current.failures + 1
  const lockedUntil =
    failures >= policy.maxFailures ? new Date(now.getTime() + policy.lockoutMs).toISOString() : null
  const record: ThrottleRecord = { failures, lockedUntil }
  setSetting(database, THROTTLE_KEY, JSON.stringify(record), now.toISOString())
  return record
}

export function clearAdminFailures(database: SqliteDatabase, at: string): void {
  setSetting(database, THROTTLE_KEY, JSON.stringify({ failures: 0, lockedUntil: null }), at)
}

/** 锁定是否仍然有效；过期则返回 null（失败计数保留，达到上限时下次失败会立刻重新锁定） */
export function activeLockout(record: ThrottleRecord, now: Date): Date | null {
  if (record.lockedUntil === null) {
    return null
  }
  const until = new Date(record.lockedUntil)
  if (!Number.isFinite(until.getTime()) || until.getTime() <= now.getTime()) {
    return null
  }
  return until
}

function readCredential(database: SqliteDatabase): CredentialRecord | null {
  const raw = getSetting(database, CREDENTIAL_KEY)
  if (raw === null) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CredentialRecord>
    if (
      parsed.v !== 1 ||
      parsed.algo !== 'scrypt' ||
      typeof parsed.N !== 'number' ||
      typeof parsed.r !== 'number' ||
      typeof parsed.p !== 'number' ||
      typeof parsed.salt !== 'string' ||
      typeof parsed.hash !== 'string'
    ) {
      return null
    }
    return {
      v: 1,
      algo: 'scrypt',
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      salt: parsed.salt,
      hash: parsed.hash,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
    }
  } catch {
    return null
  }
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return scryptSync(password, salt, KEY_BYTES, {
    N: Math.max(2, Math.floor(N)),
    r: Math.max(1, Math.floor(r)),
    p: Math.max(1, Math.floor(p)),
    maxmem: SCRYPT_MAXMEM
  })
}
