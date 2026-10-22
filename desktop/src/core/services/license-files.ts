import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { ServiceError } from './errors'

const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,120}\.json$/

/**
 * 授权文件存储接口。
 * 服务层只认这个接口，便于测试注入失败场景，也便于未来换成受控存储。
 */
export interface LicenseFileStore {
  writeAtomic(fileName: string, content: string): void
  read(fileName: string): string
  exists(fileName: string): boolean
  remove(fileName: string): void
  /** 目录内所有 .json 文件名（不含子目录） */
  list(): string[]
  /** 把孤儿文件移入隔离目录，返回是否成功 */
  quarantine(fileName: string): boolean
  readonly rootDir: string
}

/** 基于文件系统的实现：同目录临时文件 + fsync + rename，避免半写文件 */
export class FsLicenseFileStore implements LicenseFileStore {
  readonly rootDir: string
  private readonly quarantineDir: string

  constructor(rootDir: string) {
    this.rootDir = rootDir
    this.quarantineDir = join(rootDir, 'orphan')
    mkdirSync(this.rootDir, { recursive: true })
  }

  writeAtomic(fileName: string, content: string): void {
    this.assertFileName(fileName)
    const target = join(this.rootDir, fileName)
    const temp = join(this.rootDir, `.${fileName}.${randomBytes(6).toString('hex')}.tmp`)
    const fd = openSync(temp, 'wx')
    try {
      writeSync(fd, content, null, 'utf8')
      fsyncSync(fd)
    } catch (error) {
      closeSync(fd)
      rmSync(temp, { force: true })
      throw new ServiceError('license_file_error', `写入临时文件失败: ${asMessage(error)}`)
    }
    closeSync(fd)
    try {
      renameSync(temp, target)
    } catch (error) {
      rmSync(temp, { force: true })
      throw new ServiceError('license_file_error', `替换授权文件失败: ${asMessage(error)}`)
    }
  }

  read(fileName: string): string {
    this.assertFileName(fileName)
    try {
      return readFileSync(join(this.rootDir, fileName), 'utf8')
    } catch (error) {
      throw new ServiceError('license_file_error', `读取授权文件失败: ${asMessage(error)}`)
    }
  }

  exists(fileName: string): boolean {
    this.assertFileName(fileName)
    return existsSync(join(this.rootDir, fileName))
  }

  remove(fileName: string): void {
    this.assertFileName(fileName)
    rmSync(join(this.rootDir, fileName), { force: true })
  }

  list(): string[] {
    try {
      return readdirSync(this.rootDir).filter((name) => name.endsWith('.json') && FILE_NAME_PATTERN.test(name))
    } catch {
      return []
    }
  }

  quarantine(fileName: string): boolean {
    this.assertFileName(fileName)
    mkdirSync(this.quarantineDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      renameSync(join(this.rootDir, fileName), join(this.quarantineDir, `${stamp}-${fileName}`))
      return true
    } catch {
      return false
    }
  }

  private assertFileName(fileName: string): void {
    if (!FILE_NAME_PATTERN.test(fileName)) {
      throw new ServiceError('license_file_error', '授权文件名不合法')
    }
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
