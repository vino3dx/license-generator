import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createPublicKey, type KeyObject } from 'node:crypto'
import { dirname } from 'node:path'
import { exportPublicKeyParams, loadPrivateKeyFromPem } from '@core/license/rsa-keys'
import { isLicenseError } from '@core/license/errors'
import type { RsaPublicKeyParams } from '@shared/license/protocol'
import { ServiceError } from './errors'

export interface DelegatedKey {
  readonly privateKey: KeyObject
  readonly publicParams: RsaPublicKeyParams
}

/**
 * 委托签发私钥的读取接口。
 *
 * 安全边界（已知限制）：私钥保存在客户中控的本机文件里，普通 Windows 环境无法保证不被提取；
 * 本接口只负责"放在数据库/日志/构建产物之外"。后续阶段可替换为 Electron safeStorage
 * 或系统凭据存储的实现，业务层无需改动。
 */
export interface DelegatedKeyStore {
  load(): DelegatedKey | null
  /** 可选：支持导入的实现（文件存储）。内存实现不提供，导入时会显式报错。 */
  save?(pem: string): void
}

export class FileDelegatedKeyStore implements DelegatedKeyStore {
  constructor(private readonly keyFile: string) {}

  load(): DelegatedKey | null {
    if (!existsSync(this.keyFile)) {
      return null
    }
    let pem: string
    try {
      pem = readFileSync(this.keyFile, 'utf8')
    } catch (error) {
      throw new ServiceError('delegated_key_missing', `读取委托私钥失败: ${asMessage(error)}`)
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

  /** 写入 PEM（仅用于初始化/测试；调用方负责权限收紧） */
  save(pem: string): void {
    mkdirSync(dirname(this.keyFile), { recursive: true })
    writeFileSync(this.keyFile, pem, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(this.keyFile, 0o600)
    } catch {
      // Windows 上 chmod 基本无效，忽略
    }
  }
}

export function createInMemoryDelegatedKeyStore(privateKeyPem: string): DelegatedKeyStore {
  const privateKey = loadPrivateKeyFromPem(privateKeyPem)
  const key: DelegatedKey = {
    privateKey,
    publicParams: exportPublicKeyParams(createPublicKey(privateKey))
  }
  return { load: () => key }
}

export function samePublicKey(a: RsaPublicKeyParams, b: RsaPublicKeyParams): boolean {
  return a.kty === b.kty && a.n === b.n && a.e === b.e
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
