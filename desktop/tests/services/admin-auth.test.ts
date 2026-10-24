import { describe, expect, it } from 'vitest'
import { ServiceError, createLicenseServices, readThrottle } from '@core/services'
import { createHarness, FIXED_NOW } from './harness'

const PASSWORD = 'correct horse battery'

function codeOf(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    return error instanceof ServiceError ? error.code : 'not-service-error'
  }
  return 'no-error'
}

describe('管理员口令存储', () => {
  it('首次设置后自动解锁，且数据库里没有明文口令', () => {
    const harness = createHarness()
    try {
      expect(harness.services.admin.status().credentialConfigured).toBe(false)

      const status = harness.services.admin.setup(PASSWORD)
      expect(status.credentialConfigured).toBe(true)
      expect(status.unlocked).toBe(true)
      expect(status.idleRemainingMs).toBeGreaterThan(0)

      const row = harness.database
        .prepare("SELECT value FROM app_settings WHERE key = 'admin.credential'")
        .get() as { value: string } | undefined
      expect(row?.value).toBeDefined()
      expect(row?.value).not.toContain(PASSWORD)
      expect(row?.value).toContain('scrypt')
      // 审计里也不能出现口令
      const audit = harness.database.prepare('SELECT context FROM audit_logs').all() as {
        context: string | null
      }[]
      for (const entry of audit) {
        expect(entry.context ?? '').not.toContain(PASSWORD)
      }
    } finally {
      harness.cleanup()
    }
  })

  it('重复设置与弱口令都被拒绝，且不会写入半成品凭据', () => {
    const harness = createHarness()
    try {
      expect(codeOf(() => harness.services.admin.setup('short'))).toBe('admin_password_weak')
      expect(harness.services.admin.status().credentialConfigured).toBe(false)

      harness.services.admin.setup(PASSWORD)
      expect(codeOf(() => harness.services.admin.setup('another long password'))).toBe(
        'admin_already_configured'
      )
      // 旧口令仍然有效（未被覆盖）
      harness.services.admin.lock()
      expect(harness.services.admin.unlock(PASSWORD).unlocked).toBe(true)
    } finally {
      harness.cleanup()
    }
  })

  it('错误口令累计失败，达到上限后锁定，正确口令也无法解锁', () => {
    const harness = createHarness()
    try {
      harness.services.admin.setup(PASSWORD)
      harness.services.admin.lock()

      for (let attempt = 1; attempt < 5; attempt += 1) {
        expect(codeOf(() => harness.services.admin.unlock('wrong password'))).toBe(
          'admin_invalid_password'
        )
      }
      expect(codeOf(() => harness.services.admin.unlock('wrong password'))).toBe('admin_locked_out')
      // 锁定期间即使口令正确也不能解锁
      expect(codeOf(() => harness.services.admin.unlock(PASSWORD))).toBe('admin_locked_out')

      const throttle = readThrottle(harness.database)
      expect(throttle.failures).toBeGreaterThanOrEqual(5)
      expect(throttle.lockedUntil).not.toBeNull()
      expect(harness.services.admin.status().remainingAttempts).toBe(0)
    } finally {
      harness.cleanup()
    }
  })

  it('限流持久化：重建会话（模拟重启）后仍处于锁定', () => {
    const harness = createHarness()
    try {
      harness.services.admin.setup(PASSWORD)
      harness.services.admin.lock()
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          harness.services.admin.unlock('wrong password')
        } catch {
          // 逐次累计
        }
      }

      // 新实例 = 新进程（内存会话清空），但限流记录在 app_settings 里
      const restarted = createLicenseServices({
        database: harness.database,
        files: harness.files,
        delegatedKeys: harness.delegatedKeys,
        vendorPublicKey: harness.vendorPublicParams,
        clock: () => FIXED_NOW
      })
      expect(restarted.admin.status().unlocked).toBe(false)
      expect(codeOf(() => restarted.admin.unlock(PASSWORD))).toBe('admin_locked_out')
    } finally {
      harness.cleanup()
    }
  })

  it('正确口令解锁并清零失败计数', () => {
    const harness = createHarness()
    try {
      harness.services.admin.setup(PASSWORD)
      harness.services.admin.lock()
      expect(codeOf(() => harness.services.admin.unlock('wrong password'))).toBe(
        'admin_invalid_password'
      )
      expect(readThrottle(harness.database).failures).toBe(1)

      expect(harness.services.admin.unlock(PASSWORD).unlocked).toBe(true)
      expect(readThrottle(harness.database).failures).toBe(0)
    } finally {
      harness.cleanup()
    }
  })
})

describe('管理员会话与敏感操作守卫', () => {
  it('空闲超时后 requireUnlocked 逐次拒绝，重新解锁可恢复', () => {
    let nowMs = FIXED_NOW.getTime()
    const harness = createHarness({ clock: () => new Date(nowMs) })
    try {
      harness.services.admin.setup(PASSWORD)
      expect(() => harness.services.admin.requireUnlocked()).not.toThrow()

      // 14 分钟内仍有效
      nowMs += 14 * 60 * 1000
      expect(() => harness.services.admin.requireUnlocked()).not.toThrow()

      // 超过空闲阈值：同一个会话必须在这次调用上被判定为锁定
      nowMs += 2 * 60 * 1000
      expect(codeOf(() => harness.services.admin.requireUnlocked())).toBe('admin_locked')
      expect(harness.services.admin.status().unlocked).toBe(false)

      // 空闲锁定不是永久失败，重新解锁即可
      expect(harness.services.admin.unlock(PASSWORD).unlocked).toBe(true)
      expect(() => harness.services.admin.requireUnlocked()).not.toThrow()
    } finally {
      harness.cleanup()
    }
  })

  it('敏感操作成功后 touch 会延长会话', () => {
    let nowMs = FIXED_NOW.getTime()
    const harness = createHarness({ clock: () => new Date(nowMs) })
    try {
      harness.services.admin.setup(PASSWORD)
      nowMs += 10 * 60 * 1000
      harness.services.admin.touch()
      nowMs += 10 * 60 * 1000
      // 距离最后一次操作只有 10 分钟，未超过 15 分钟阈值
      expect(() => harness.services.admin.requireUnlocked()).not.toThrow()
    } finally {
      harness.cleanup()
    }
  })

  it('手动锁定后立即拒绝，且状态变为只读', () => {
    const harness = createHarness()
    try {
      harness.services.admin.setup(PASSWORD)
      const locked = harness.services.admin.lock()
      expect(locked.unlocked).toBe(false)
      expect(codeOf(() => harness.services.admin.requireUnlocked())).toBe('admin_locked')
    } finally {
      harness.cleanup()
    }
  })

  it('未设置口令时任何敏感操作都不能通过', () => {
    const harness = createHarness()
    try {
      expect(codeOf(() => harness.services.admin.requireUnlocked())).toBe('admin_locked')
      expect(codeOf(() => harness.services.admin.unlock(PASSWORD))).toBe('admin_not_configured')
    } finally {
      harness.cleanup()
    }
  })

  it('修改口令需要已解锁且旧口令正确，旧口令立即失效', () => {
    const harness = createHarness()
    try {
      harness.services.admin.setup(PASSWORD)
      harness.services.admin.lock()
      expect(codeOf(() => harness.services.admin.changePassword(PASSWORD, 'next long password'))).toBe(
        'admin_locked'
      )

      harness.services.admin.unlock(PASSWORD)
      expect(codeOf(() => harness.services.admin.changePassword('wrong password', 'next long password'))).toBe(
        'admin_invalid_password'
      )
      expect(codeOf(() => harness.services.admin.changePassword(PASSWORD, 'short'))).toBe(
        'admin_password_weak'
      )

      harness.services.admin.changePassword(PASSWORD, 'next long password')
      harness.services.admin.lock()
      expect(codeOf(() => harness.services.admin.unlock(PASSWORD))).toBe('admin_invalid_password')
      expect(harness.services.admin.unlock('next long password').unlocked).toBe(true)
    } finally {
      harness.cleanup()
    }
  })
})
