import { userInfo } from 'node:os'
import type { KeyObject } from 'node:crypto'
import { importPublicKeyParams } from '@core/license/rsa-keys'
import type { RsaPublicKeyParams } from '@shared/license/protocol'
import type { SqliteDatabase } from '@core/db'
import type { DelegatedKeyStore } from './delegated-key'
import type { LicenseFileStore } from './license-files'

/**
 * 业务层依赖。全部由调用方（Electron 主进程 / 测试）注入：
 * - 数据库连接与文件仓库可替换，便于测试失败路径；
 * - 厂商公钥是编译进程序的信任根，不来自数据库。
 */
export interface ServiceDependencies {
  readonly database: SqliteDatabase
  readonly files: LicenseFileStore
  readonly delegatedKeys: DelegatedKeyStore
  /** null 表示未配置厂商公钥：需要验证中控证书的操作会 fail-closed */
  readonly vendorPublicKey: RsaPublicKeyParams | null
  readonly clock?: () => Date
  /** 审计里的操作者；默认取当前系统用户名 */
  readonly actor?: string
}

export interface ResolvedDependencies {
  readonly database: SqliteDatabase
  readonly files: LicenseFileStore
  readonly delegatedKeys: DelegatedKeyStore
  readonly vendorPublicKey: RsaPublicKeyParams | null
  readonly vendorKeyObject: KeyObject | null
  readonly now: () => Date
  readonly actor: string
}

export function resolveDependencies(dependencies: ServiceDependencies): ResolvedDependencies {
  return {
    database: dependencies.database,
    files: dependencies.files,
    delegatedKeys: dependencies.delegatedKeys,
    vendorPublicKey: dependencies.vendorPublicKey,
    vendorKeyObject:
      dependencies.vendorPublicKey === null ? null : importPublicKeyParams(dependencies.vendorPublicKey),
    now: dependencies.clock ?? (() => new Date()),
    actor: dependencies.actor ?? currentActor()
  }
}

function currentActor(): string {
  try {
    const name = userInfo().username
    return name.length > 0 ? name : 'local-console'
  } catch {
    return 'local-console'
  }
}
