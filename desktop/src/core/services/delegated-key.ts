import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createPublicKey, type KeyObject } from 'node:crypto'
import { dirname } from 'node:path'
import { exportPublicKeyParams, loadPrivateKeyFromPem } from '@core/license/rsa-keys'
import { isLicenseError } from '@core/license/errors'
import type { RsaPublicKeyParams } from '@shared/license/protocol'
import type { DelegatedKeyProtection } from '@shared/license/service-contract'
import { ServiceError } from './errors'

export interface DelegatedKey {
  readonly privateKey: KeyObject
  readonly publicParams: RsaPublicKeyParams
}

/** 与 shared 的 DelegatedKeyProtection 对应，避免两处枚举漂移 */
export type KeyProtectionState = DelegatedKeyProtection

export interface KeyProtectionStatus {
  readonly state: KeyProtectionState
  /** 非空表示存在需要操作员处理的安全问题（例如遗留明文、系统加密不可用） */
  readonly error: string | null
}

/**
 * 系统安全存储的抽象（生产实现为 Electron safeStorage / Windows DPAPI，测试用可控实现）。
 * 业务层只依赖该接口，"加密是否可用"由实现回答，不允许降级为明文。
 */
export interface KeyProtector {
  readonly available: boolean
  encrypt(plaintext: string): Buffer
  decrypt(payload: Buffer): string
}

/**
 * 委托签发私钥的读取接口。
 *
 * 安全边界（M2）：私钥必须由系统安全存储加密后落盘；明文 PEM 只允许存在于待迁移的旧文件里，
 * 且不会被加载使用。本接口不返回任何可被渲染进程拿到的密钥内容。
 */
export interface DelegatedKeyStore {
  load(): DelegatedKey | null
  /** 可选：支持导入的实现（文件存储）。内存实现不提供，导入时会显式报错。 */
  save?(pem: string): void
  /** 可选：密钥保护状态；未实现的存储（如测试内存实现）视为不涉及落盘 */
  protection?(): KeyProtectionStatus
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
