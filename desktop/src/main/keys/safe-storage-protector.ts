import { safeStorage } from 'electron'
import type { KeyProtector } from '@core/services'

/**
 * 生产环境的密钥保护实现：Electron safeStorage。
 * Windows 上底层为 DPAPI，加密数据绑定当前系统用户；
 * 把数据库与密钥文件拷到另一台机器无法直接解密。
 *
 * 注意：这不能防御"以同一 Windows 用户身份运行"的恶意程序，
 * 只能避免明文落盘与跨机器复制。UI 与文档必须如实说明。
 */
export class SafeStorageKeyProtector implements KeyProtector {
  get available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      // 主进程未就绪或平台不支持：一律视为不可用（fail-closed）
      return false
    }
  }

  encrypt(plaintext: string): Buffer {
    if (!this.available) {
      throw new Error('系统安全存储不可用（safeStorage.isEncryptionAvailable() === false）')
    }
    return safeStorage.encryptString(plaintext)
  }

  decrypt(payload: Buffer): string {
    if (!this.available) {
      throw new Error('系统安全存储不可用（safeStorage.isEncryptionAvailable() === false）')
    }
    return safeStorage.decryptString(payload)
  }
}
