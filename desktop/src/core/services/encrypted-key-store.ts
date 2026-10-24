import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createPublicKey } from 'node:crypto'
import { dirname } from 'node:path'
import { exportPublicKeyParams, loadPrivateKeyFromPem } from '@core/license/rsa-keys'
import { isLicenseError } from '@core/license/errors'
import {
  type DelegatedKey,
  type DelegatedKeyStore,
  type KeyProtectionStatus,
  type KeyProtector
} from './delegated-key'
import { ServiceError } from './errors'

/** 加密密钥文件的魔数/版本头：便于识别文件类型，也避免把任意二进制当成密钥 */
const MAGIC = Buffer.from('AEGIS-KEY-1\n', 'utf8')

/**
 * 使用系统安全存储（Windows DPAPI / Electron safeStorage）保存委托私钥。
 *
 * 安全规则（M2）：
 * - 加密不可用时**拒绝**导入与签发，绝不静默写明文；
 * - 旧的明文 PEM 绝不会被自动加载使用，只能通过 migrateLegacy() 加密迁移；
 * - 迁移采用"临时文件 → 读回校验 → 原子替换 → 删除旧明文"的顺序，
 *   任一步失败都保留旧文件，且不会留下半写的新文件。
 */
export class EncryptedFileDelegatedKeyStore implements DelegatedKeyStore {
  constructor(
    private readonly encryptedFile: string,
    private readonly legacyFile: string,
    private readonly protector: KeyProtector
  ) {}

  load(): DelegatedKey | null {
    // 只认加密文件：旧明文文件即使存在也不加载（避免静默降级）
    if (!existsSync(this.encryptedFile)) {
      return null
    }
    let payload: Buffer
    try {
      payload = readFileSync(this.encryptedFile)
    } catch (error) {
      throw new ServiceError('key_protection_unavailable', `读取加密私钥失败: ${asMessage(error)}`)
    }
    const cipher = stripMagic(payload)
    if (!this.protector.available) {
      throw new ServiceError('key_protection_unavailable', '系统安全存储不可用，无法解密已加密的委托私钥')
    }
    let pem: string
    try {
      pem = this.protector.decrypt(cipher)
    } catch (error) {
      throw new ServiceError('key_protection_unavailable', `解密委托私钥失败: ${asMessage(error)}`)
    }
    try {
      const privateKey = loadPrivateKeyFromPem(pem)
      return { privateKey, publicParams: exportPublicKeyParams(createPublicKey(privateKey)) }
    } catch (error) {
      if (isLicenseError(error)) {
        throw new ServiceError('delegated_key_missing', `委托私钥不合法: ${error.message}`)
      }
      throw error
    }
  }

  /** 加密保存：先写临时文件并读回校验，成功后才替换并清理旧明文 */
  save(pem: string): void {
    if (!this.protector.available) {
      throw new ServiceError(
        'key_protection_unavailable',
        '当前系统安全存储不可用（safeStorage），出于安全考虑拒绝以明文保存委托私钥；请检查系统凭据保护后重试'
      )
    }
    const cipher = this.protector.encrypt(pem)
    mkdirSync(dirname(this.encryptedFile), { recursive: true })
    const temp = `${this.encryptedFile}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(temp, Buffer.concat([MAGIC, cipher]), { mode: 0o600, flag: 'wx' })
      // 读回校验：只有确认能解出完全相同的 PEM 才允许替换
      const verified = this.protector.decrypt(stripMagic(readFileSync(temp)))
      if (verified !== pem) {
        throw new Error('加密后校验不一致')
      }
      renameSync(temp, this.encryptedFile)
    } catch (error) {
      rmSync(temp, { force: true })
      throw new ServiceError(
        'key_protection_unavailable',
        `保存加密私钥失败，原密钥文件保持不变: ${asMessage(error)}`
      )
    }
    // 加密文件已确认可用，才处理旧明文；删除失败不影响加密文件，但会在状态里提示
    this.removeLegacy()
  }

  /**
   * 把旧的明文 PEM 迁移为加密存储。
   * 返回迁移后的保护状态；失败时旧文件保持原样，且不会被加载使用。
   */
  migrateLegacy(): KeyProtectionStatus {
    if (!existsSync(this.legacyFile)) {
      return this.status()
    }
    if (!this.protector.available) {
      return {
        state: 'unavailable',
        error: '系统安全存储不可用：检测到的旧明文私钥文件未被使用，也无法迁移'
      }
    }
    let pem: string
    try {
      pem = readFileSync(this.legacyFile, 'utf8')
    } catch (error) {
      return { state: 'legacy_plaintext', error: `读取旧明文私钥失败: ${asMessage(error)}` }
    }
    try {
      this.save(pem)
    } catch (error) {
      return {
        state: 'legacy_plaintext',
        error: `私钥加密迁移失败，旧明文文件已保留且不会被加载: ${asMessage(error)}`
      }
    }
    return this.status()
  }

  protection(): KeyProtectionStatus {
    return this.status()
  }

  private status(): KeyProtectionStatus {
    if (!this.protector.available) {
      return {
        state: 'unavailable',
        error: '当前系统安全存储不可用（safeStorage.isEncryptionAvailable() === false），私钥导入与签发已停用'
      }
    }
    const hasEncrypted = existsSync(this.encryptedFile)
    const hasLegacy = existsSync(this.legacyFile)
    if (hasEncrypted) {
      return {
        state: 'encrypted',
        error: hasLegacy ? '检测到遗留的明文私钥文件，已不再使用；确认加密可用后请手工删除' : null
      }
    }
    if (hasLegacy) {
      return {
        state: 'legacy_plaintext',
        error: '仅存在未加密的旧私钥文件，出于安全考虑不会加载；请重新导入私钥完成加密迁移'
      }
    }
    return { state: 'encrypted', error: null }
  }

  private removeLegacy(): void {
    if (!existsSync(this.legacyFile)) {
      return
    }
    try {
      rmSync(this.legacyFile, { force: true })
    } catch {
      // 删除失败时保留文件，状态里会提示遗留明文；不能因为清理失败而丢掉已加密的私钥
    }
  }
}

function stripMagic(payload: Buffer): Buffer {
  if (payload.length <= MAGIC.length || !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ServiceError('key_protection_unavailable', '无法识别的委托私钥文件格式')
  }
  return payload.subarray(MAGIC.length)
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
