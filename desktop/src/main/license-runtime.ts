import { app } from 'electron'
import { join } from 'node:path'
import { createDatabase, type SqliteDatabase } from '@core/db'
import {
  EncryptedFileDelegatedKeyStore,
  FsLicenseFileStore,
  createLicenseServices,
  toServiceErrorPayload,
  type LicenseServices
} from '@core/services'
import type { ServiceErrorPayload } from '@shared/license/service-contract'
import { SafeStorageKeyProtector } from './keys/safe-storage-protector'
import { resolveVendorPublicKey } from './vendor-trust'

export interface LicenseRuntime {
  readonly database: SqliteDatabase
  readonly services: LicenseServices
  /** 厂商公钥是否已配置；false 时所有需要验证中控证书的操作都会 fail-closed */
  readonly vendorKeyConfigured: boolean
}

interface RuntimeState {
  runtime: LicenseRuntime | null
  error: ServiceErrorPayload | null
}

let state: RuntimeState = { runtime: null, error: null }

/**
 * 初始化本地授权运行时（数据库迁移 + 中断恢复 + 服务装配）。
 * 数据放在 userData，不写安装目录；厂商公钥缺失时不伪造信任根，只记录错误。
 */
export function initLicenseRuntime(): void {
  if (state.runtime !== null) {
    return
  }
  const userData = app.getPath('userData')
  try {
    const { database } = createDatabase(join(userData, 'aegis.sqlite'))
    // 公钥缺失不再让整个运行时失败：项目与审计仍可用，证书相关操作在业务层 fail-closed
    const vendorPublicKey = resolveVendorPublicKey()
    const keysDir = join(userData, 'keys')
    const delegatedKeys = new EncryptedFileDelegatedKeyStore(
      join(keysDir, 'delegated.key.enc'),
      join(keysDir, 'delegated.key.pem'),
      new SafeStorageKeyProtector()
    )
    // 旧的明文 PEM 只有加密迁移成功后才删除；失败时保留但不加载（不静默降级）
    const keyProtection = delegatedKeys.migrateLegacy()
    if (keyProtection.error !== null) {
      console.warn('[aegis] 委托私钥保护状态:', keyProtection.state, keyProtection.error)
    }
    const services = createLicenseServices({
      database,
      files: new FsLicenseFileStore(join(userData, 'licenses')),
      delegatedKeys,
      vendorPublicKey
    })
    // 上次运行可能中断在"已预留记录、未写文件"的状态，启动时先对账
    services.maintenance.reconcile()
    state = { runtime: { database, services, vendorKeyConfigured: vendorPublicKey !== null }, error: null }
  } catch (error) {
    state = { runtime: null, error: toServiceErrorPayload(error) }
    console.error('[aegis] 授权运行时初始化失败', error)
  }
}

export function getLicenseRuntime(): LicenseRuntime {
  if (state.runtime === null) {
    throw new Error(state.error?.message ?? '授权运行时尚未初始化')
  }
  return state.runtime
}

export function getLicenseRuntimeError(): ServiceErrorPayload | null {
  return state.error
}

export function closeLicenseRuntime(): void {
  state.runtime?.database.close()
  state = { runtime: null, error: null }
}
