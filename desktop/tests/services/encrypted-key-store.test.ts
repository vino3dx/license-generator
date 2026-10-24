import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EncryptedFileDelegatedKeyStore, ServiceError, type KeyProtector } from '@core/services'

const PEM = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'keys', 'delegate-test.private.pem'), 'utf8')

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-keystore-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 句柄延迟释放
    }
  }
})

/** 测试用"安全存储"：可切换可用性，并可模拟写后校验失败 */
class FakeProtector implements KeyProtector {
  available = true
  /** 让读回校验返回错误内容，模拟加密实现异常 */
  breakVerification = false
  private reads = 0

  encrypt(plaintext: string): Buffer {
    if (!this.available) {
      throw new Error('不可用')
    }
    return Buffer.from(`enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`, 'utf8')
  }

  decrypt(payload: Buffer): string {
    if (!this.available) {
      throw new Error('不可用')
    }
    this.reads += 1
    const text = payload.toString('utf8')
    if (!text.startsWith('enc:')) {
      throw new Error('密文格式错误')
    }
    const decoded = Buffer.from(text.slice(4), 'base64').toString('utf8')
    if (this.breakVerification && this.reads === 1) {
      return `${decoded}\ntampered`
    }
    return decoded
  }
}

function codeOf(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    return error instanceof ServiceError ? error.code : 'not-service-error'
  }
  return 'no-error'
}

describe('委托私钥加密存储', () => {
  it('加密保存后不落明文，且可重新读取', () => {
    const dir = tempDir()
    const encFile = join(dir, 'delegated.key.enc')
    const legacyFile = join(dir, 'delegated.key.pem')
    const store = new EncryptedFileDelegatedKeyStore(encFile, legacyFile, new FakeProtector())

    store.save(PEM)

    const raw = readFileSync(encFile, 'utf8')
    expect(raw.startsWith('AEGIS-KEY-1')).toBe(true)
    expect(raw).not.toContain('PRIVATE')
    expect(raw).not.toContain('BEGIN')

    const loaded = store.load()
    expect(loaded).not.toBeNull()
    expect(loaded?.publicParams.kty).toBe('RSA')
    expect(store.protection().state).toBe('encrypted')
    expect(store.protection().error).toBeNull()
  })

  it('系统加密不可用时拒绝保存，不产生任何文件', () => {
    const dir = tempDir()
    const encFile = join(dir, 'delegated.key.enc')
    const legacyFile = join(dir, 'delegated.key.pem')
    const protector = new FakeProtector()
    protector.available = false
    const store = new EncryptedFileDelegatedKeyStore(encFile, legacyFile, protector)

    expect(codeOf(() => store.save(PEM))).toBe('key_protection_unavailable')
    expect(existsSync(encFile)).toBe(false)
    expect(store.load()).toBeNull()
    const status = store.protection()
    expect(status.state).toBe('unavailable')
    expect(status.error).toContain('安全存储不可用')
  })

  it('旧明文私钥不会被加载，只能通过加密迁移使用', () => {
    const dir = tempDir()
    const encFile = join(dir, 'delegated.key.enc')
    const legacyFile = join(dir, 'delegated.key.pem')
    writeFileSync(legacyFile, PEM, 'utf8')
    const store = new EncryptedFileDelegatedKeyStore(encFile, legacyFile, new FakeProtector())

    // 未迁移前：即使明文存在也不加载（避免静默降级）
    expect(store.load()).toBeNull()
    expect(store.protection().state).toBe('legacy_plaintext')

    const migrated = store.migrateLegacy()
    expect(migrated.state).toBe('encrypted')
    expect(existsSync(legacyFile)).toBe(false)
    expect(existsSync(encFile)).toBe(true)
    expect(store.load()).not.toBeNull()
  })

  it('迁移失败时保留旧明文，且不会把它当成可用私钥', () => {
    const dir = tempDir()
    const encFile = join(dir, 'delegated.key.enc')
    const legacyFile = join(dir, 'delegated.key.pem')
    writeFileSync(legacyFile, PEM, 'utf8')
    const protector = new FakeProtector()
    protector.available = false
    const store = new EncryptedFileDelegatedKeyStore(encFile, legacyFile, protector)

    const migrated = store.migrateLegacy()
    expect(migrated.state).toBe('unavailable')
    expect(existsSync(legacyFile)).toBe(true)
    expect(readFileSync(legacyFile, 'utf8')).toBe(PEM)
    expect(existsSync(encFile)).toBe(false)
    expect(store.load()).toBeNull()
  })

  it('写入校验失败时保留原有加密文件，且不留下临时文件', () => {
    const dir = tempDir()
    const encFile = join(dir, 'delegated.key.enc')
    const legacyFile = join(dir, 'delegated.key.pem')
    const healthy = new EncryptedFileDelegatedKeyStore(encFile, legacyFile, new FakeProtector())
    healthy.save(PEM)
    const before = readFileSync(encFile, 'utf8')

    const broken = new FakeProtector()
    broken.breakVerification = true
    const store = new EncryptedFileDelegatedKeyStore(encFile, legacyFile, broken)
    expect(codeOf(() => store.save(`${PEM}\n`))).toBe('key_protection_unavailable')

    expect(readFileSync(encFile, 'utf8')).toBe(before)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(store.load()).not.toBeNull()
  })

  it('加密文件格式异常时给出明确错误，而不是当作未配置', () => {
    const dir = tempDir()
    const encFile = join(dir, 'delegated.key.enc')
    writeFileSync(encFile, 'not-an-aegis-key', 'utf8')
    const store = new EncryptedFileDelegatedKeyStore(encFile, join(dir, 'delegated.key.pem'), new FakeProtector())

    expect(codeOf(() => store.load())).toBe('key_protection_unavailable')
  })
})
