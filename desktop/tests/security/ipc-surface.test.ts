import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
