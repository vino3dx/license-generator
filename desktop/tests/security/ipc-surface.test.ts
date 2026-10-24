import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADMIN_IPC_CHANNELS } from '@shared/license/admin-contract'
import { HUB_IPC_CHANNELS } from '@shared/license/hub-contract'
import { LICENSE_IPC_CHANNELS } from '@shared/license/service-contract'

const root = process.cwd()

function readSource(relative: string): string {
  return readFileSync(join(root, relative), 'utf8')
}

function walk(relativeDir: string): string[] {
  const dir = join(root, relativeDir)
  if (!existsSync(dir)) {
    return []
  }
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...walk(join(relativeDir, entry)))
    } else {
      files.push(full)
    }
  }
  return files
}

describe('渲染进程权限边界', () => {
  it('preload 不直接使用文件系统、数据库或其他 Node 能力', () => {
    const source = readSource('src/preload/index.ts')
    for (const forbidden of ['node:fs', 'node:path', 'node:sqlite', 'child_process', 'ipcRenderer.on(']) {
      expect(source).not.toContain(forbidden)
    }
    expect(source).toContain('contextBridge.exposeInMainWorld')
  })

  it('共享契约不引入 Node.js 模块（会被渲染进程打包）', () => {
    const files = walk('src/shared')
    expect(files.length).toBeGreaterThan(2)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/from 'node:/)
      expect(source).not.toContain("require('node:")
    }
  })

  it('渲染进程不引用核心业务层与数据库', () => {
    for (const file of walk('src/renderer')) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toContain('@core/db')
      expect(source).not.toContain('@core/services')
      expect(source).not.toContain('node:sqlite')
      expect(source).not.toContain('node:fs')
    }
  })

  it('preload 只使用已登记的 IPC 通道', () => {
    const source = readSource('src/preload/index.ts')
    const used = [...source.matchAll(/LICENSE_IPC_CHANNELS\.(\w+)/g)].map((match) => match[1])
    const allowed = Object.keys(LICENSE_IPC_CHANNELS)
    expect(used.length).toBeGreaterThan(10)
    for (const name of used) {
      expect(allowed).toContain(name)
    }
    expect(new Set(used).size).toBe(allowed.length)
  })

  it('通道名唯一且带命名空间', () => {
    const channels = Object.values(LICENSE_IPC_CHANNELS)
    expect(new Set(channels).size).toBe(channels.length)
    for (const channel of channels) {
      expect(channel).toMatch(/^license:[a-z-]+$/)
    }
  })

  it('IPC 层不接受文件路径参数，也不引入文件系统', () => {
    const source = readSource('src/main/ipc/license.ts')
    expect(source).not.toContain("from 'node:fs'")
    expect(source).not.toContain("from 'node:path'")
    expect(source).not.toContain('writeFile')
    expect(source).not.toContain('readFile')
  })

  it('业务服务层不暴露原始数据库连接', () => {
    const source = readSource('src/core/services/index.ts')
    expect(source).not.toContain('database:')
    expect(source).not.toContain('SqliteDatabase')
  })
})

describe('管理员通道与敏感操作守卫', () => {
  it('preload 使用了全部已登记的管理员通道', () => {
    const source = readSource('src/preload/index.ts')
    const used = [...source.matchAll(/ADMIN_IPC_CHANNELS\.(\w+)/g)].map((match) => match[1])
    const allowed = Object.keys(ADMIN_IPC_CHANNELS)
    for (const name of used) {
      expect(allowed).toContain(name)
    }
    expect(new Set(used).size).toBe(allowed.length)
  })

  it('管理员通道名唯一且带 admin: 前缀', () => {
    const channels = Object.values(ADMIN_IPC_CHANNELS)
    expect(new Set(channels).size).toBe(channels.length)
    for (const channel of channels) {
      expect(channel).toMatch(/^admin:[a-z-]+$/)
    }
  })

  it('写操作与授权能力相关通道都在主进程声明为敏感（需解锁）', () => {
    const source = readSource('src/main/ipc/license.ts')
    expect(source).toContain('SENSITIVE_CHANNELS')
    expect(source).toContain('requireUnlocked()')
    const required = [
      'deviceRegister',
      'deviceUnbind',
      'deviceLock',
      'deviceUnlock',
      'controlImport',
      'delegatedKeyImport',
      'licenseIssue',
      'licenseBatchIssue',
      'licenseRenew'
    ]
    const sensitiveBlock = source.slice(
      source.indexOf('const SENSITIVE_CHANNELS'),
      source.indexOf(']', source.indexOf('const SENSITIVE_CHANNELS'))
    )
    for (const name of required) {
      expect(sensitiveBlock).toContain(`LICENSE_IPC_CHANNELS.${name}`)
    }
  })

  it('管理员口令相关源码不把口令写入日志或审计上下文', () => {
    for (const file of ['src/main/ipc/admin.ts', 'src/core/services/admin-session.ts']) {
      const source = readSource(file)
      expect(source).not.toContain('console.log')
      expect(source).not.toContain('console.warn')
      expect(source).not.toContain('console.error')
    }
  })
})

describe('Hub 通道与网络边界', () => {
  it('preload 使用了全部已登记的 Hub 通道', () => {
    const source = readSource('src/preload/index.ts')
    const used = [...source.matchAll(/HUB_IPC_CHANNELS\.(\w+)/g)].map((match) => match[1])
    const allowed = Object.keys(HUB_IPC_CHANNELS)
    for (const name of used) {
      expect(allowed).toContain(name)
    }
    expect(new Set(used).size).toBe(allowed.length)
  })

  it('Hub 通道名唯一且带 hub: 前缀', () => {
    const channels = Object.values(HUB_IPC_CHANNELS)
    expect(new Set(channels).size).toBe(channels.length)
    for (const channel of channels) {
      expect(channel).toMatch(/^hub:[a-z-]+$/)
    }
  })

  it('Hub 启停通道在 IPC 层要求管理员解锁', () => {
    const source = readSource('src/main/ipc/hub.ts')
    expect(source).toContain('requireUnlocked()')
    expect(source).toContain('HUB_IPC_CHANNELS.hubStart')
    expect(source).toContain('HUB_IPC_CHANNELS.hubStop')
  })

  it('网络服务只在主进程实现，渲染进程不引用 socket/fs', () => {
    const hubSource = readSource('src/main/hub/hub-server.ts')
    expect(hubSource).toContain("from 'node:dgram'")
    expect(hubSource).toContain("from 'node:net'")
    for (const file of walk('src/renderer')) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toContain('node:net')
      expect(source).not.toContain('node:dgram')
      expect(source).not.toContain('createServer')
    }
  })
})

describe('构建产物不含数据层实现', () => {
  it('渲染进程打包结果不含 sqlite 与数据库路径', () => {
    const assetsDir = join(root, 'out', 'renderer', 'assets')
    if (!existsSync(assetsDir)) {
      // 未构建时跳过（npm run build 之后会覆盖该检查）
      return
    }
    for (const file of readdirSync(assetsDir).filter((name) => name.endsWith('.js'))) {
      const source = readFileSync(join(assetsDir, file), 'utf8')
      expect(source).not.toContain('node:sqlite')
      expect(source).not.toContain('aegis.sqlite')
      expect(source).not.toContain('BEGIN PRIVATE KEY')
    }
  })
})
