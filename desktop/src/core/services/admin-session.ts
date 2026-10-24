import type { SqliteDatabase } from '@core/db'
import { formatTimestamp } from '@core/license/encoding'
import type { AdminStatusDto } from '@shared/license/admin-contract'
import {
  activeLockout,
  assertAdminPasswordPolicy,
  clearAdminFailures,
  isAdminConfigured,
  readThrottle,
  recordAdminFailure,
  verifyAdminPassword,
  writeAdminPassword
} from './admin-credential'
import { writeAudit } from './audit'
import type { ResolvedDependencies } from './context'
import { ServiceError } from './errors'

/**
 * 管理员会话（进程内存态，不落盘）。
 *
 * 关键约束：
 * - 解锁状态只存在于主进程；渲染进程无法伪造。
 * - 每次敏感操作都要走 requireUnlocked()，空闲超时在这里逐个请求判定，
 *   而不是只在解锁时判断一次。
 * - 失败限流持久化在 app_settings，重启后仍然生效。
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000
export const DEFAULT_MAX_FAILURES = 5
export const DEFAULT_LOCKOUT_MS = 5 * 60 * 1000

export interface AdminSessionOptions {
  readonly idleTimeoutMs?: number
  readonly maxFailures?: number
  readonly lockoutMs?: number
  readonly now?: () => Date
}

export class AdminSession {
  private readonly idleTimeoutMs: number
  private readonly maxFailures: number
  private readonly lockoutMs: number
  private readonly clock: () => Date
  private unlocked = false
  private lastActivityAt = 0

  constructor(
    private readonly deps: ResolvedDependencies,
    options: AdminSessionOptions = {}
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES
    this.lockoutMs = options.lockoutMs ?? DEFAULT_LOCKOUT_MS
    this.clock = options.now ?? deps.now
  }

  get database(): SqliteDatabase {
    return this.deps.database
  }

  status(): AdminStatusDto {
    this.expireIfIdle(false)
    const throttle = readThrottle(this.deps.database)
    const lockout = activeLockout(throttle, this.clock())
    const remainingAttempts = Math.max(0, this.maxFailures - throttle.failures)
    return {
      credentialConfigured: isAdminConfigured(this.deps.database),
      unlocked: this.unlocked,
      idleRemainingMs: this.unlocked ? Math.max(0, this.idleTimeoutMs - this.idleElapsed()) : 0,
      idleTimeoutMs: this.idleTimeoutMs,
      lockedOutUntil: lockout === null ? null : lockout.toISOString(),
      remainingAttempts: lockout === null ? remainingAttempts : 0
    }
  }

  /** 首次设置口令；已配置时拒绝（改口令必须走 changePassword） */
  setup(password: unknown): AdminStatusDto {
    if (isAdminConfigured(this.deps.database)) {
      throw new ServiceError('admin_already_configured', '管理员口令已设置，请使用修改口令')
    }
    const checked = assertAdminPasswordPolicy(password)
    const now = this.clock()
    writeAdminPassword(this.deps.database, checked, formatTimestamp(now))
    clearAdminFailures(this.deps.database, formatTimestamp(now))
    this.audit('admin_setup', 'success', null, now)
    this.markUnlocked(now)
    return this.status()
  }

  unlock(password: unknown): AdminStatusDto {
    if (!isAdminConfigured(this.deps.database)) {
      throw new ServiceError('admin_not_configured', '尚未设置管理员口令')
    }
    const now = this.clock()
    const throttle = readThrottle(this.deps.database)
    const lockout = activeLockout(throttle, now)
    if (lockout !== null) {
      this.audit('admin_unlock', 'failure', 'admin_locked_out', now, { lockedOutUntil: lockout.toISOString() })
      throw new ServiceError('admin_locked_out', '失败次数过多，管理员登录已临时锁定', {
        lockedOutUntil: lockout.toISOString()
      })
    }

    if (!verifyAdminPassword(this.deps.database, password)) {
      const next = recordAdminFailure(this.deps.database, now, {
        maxFailures: this.maxFailures,
        lockoutMs: this.lockoutMs
      })
      const lockedOut = next.lockedUntil !== null && next.failures >= this.maxFailures
      this.audit(
        lockedOut ? 'admin_lockout' : 'admin_unlock',
        'failure',
        lockedOut ? 'admin_locked_out' : 'admin_invalid_password',
        now,
        { failures: next.failures, lockedOutUntil: next.lockedUntil ?? '' }
      )
      if (lockedOut && next.lockedUntil !== null) {
        throw new ServiceError('admin_locked_out', '失败次数过多，管理员登录已临时锁定', {
          lockedOutUntil: next.lockedUntil
        })
      }
      throw new ServiceError('admin_invalid_password', '管理员口令不正确', {
        remainingAttempts: Math.max(0, this.maxFailures - next.failures)
      })
    }

    clearAdminFailures(this.deps.database, formatTimestamp(now))
    this.markUnlocked(now)
    this.audit('admin_unlock', 'success', null, now)
    return this.status()
  }

  lock(): AdminStatusDto {
    const now = this.clock()
    if (this.unlocked) {
      this.unlocked = false
      this.lastActivityAt = 0
      this.audit('admin_lock', 'success', null, now, { reason: 'manual' })
    }
    return this.status()
  }

  changePassword(currentPassword: unknown, newPassword: unknown): AdminStatusDto {
    this.requireUnlocked()
    if (!verifyAdminPassword(this.deps.database, currentPassword)) {
      const now = this.clock()
      this.audit('admin_password_change', 'failure', 'admin_invalid_password', now)
      throw new ServiceError('admin_invalid_password', '当前管理员口令不正确')
    }
    const checked = assertAdminPasswordPolicy(newPassword)
    const now = this.clock()
    writeAdminPassword(this.deps.database, checked, formatTimestamp(now))
    clearAdminFailures(this.deps.database, formatTimestamp(now))
    this.audit('admin_password_change', 'success', null, now)
    this.touch()
    return this.status()
  }

  /**
   * 敏感操作守卫：未解锁或已空闲超时一律拒绝。
   * 每个敏感 IPC 调用都必须经过这里，不能只在解锁时判断一次。
   */
  requireUnlocked(): void {
    if (!this.unlocked) {
      throw new ServiceError('admin_locked', '管理员未解锁：该操作需要先输入管理员口令')
    }
    if (this.expireIfIdle(true)) {
      throw new ServiceError('admin_locked', '管理员会话已超时锁定，请重新输入口令')
    }
  }

  /** 敏感操作成功后刷新活跃时间；失败不延长会话 */
  touch(): void {
    if (this.unlocked) {
      this.lastActivityAt = this.clock().getTime()
    }
  }

  private markUnlocked(now: Date): void {
    this.unlocked = true
    this.lastActivityAt = now.getTime()
  }

  private idleElapsed(): number {
    if (this.lastActivityAt === 0) {
      return Number.POSITIVE_INFINITY
    }
    return this.clock().getTime() - this.lastActivityAt
  }

  /** 返回是否因空闲超时被锁定 */
  private expireIfIdle(audit: boolean): boolean {
    if (!this.unlocked) {
      return false
    }
    if (this.idleElapsed() < this.idleTimeoutMs) {
      return false
    }
    this.unlocked = false
    this.lastActivityAt = 0
    if (audit) {
      this.audit('admin_lock', 'success', null, this.clock(), { reason: 'idle_timeout' })
    }
    return true
  }

  private audit(
    action: string,
    result: 'success' | 'failure',
    errorCode: string | null,
    now: Date,
    context?: Record<string, string | number | boolean>
  ): void {
    writeAudit(this.deps, {
      at: formatTimestamp(now),
      action,
      targetType: 'admin',
      targetId: 'local-console',
      result,
      errorCode,
      context: context === undefined ? null : JSON.stringify(context)
    })
  }
}

/** 供测试与主进程共用：按依赖创建会话对象 */
export function createAdminSession(deps: ResolvedDependencies, options: AdminSessionOptions = {}): AdminSession {
  return new AdminSession(deps, options)
}
