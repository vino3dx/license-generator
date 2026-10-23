// ESM resolve 钩子：
// 1. 把 @core/xxx、@shared/xxx 映射到 src 下同名 .ts 文件；
// 2. 为 src 内部的相对无扩展名导入（TS 风格 `./errors`）补 .ts / index.ts。
// 仅服务 scripts/ 下的开发工具，不参与 electron-vite 构建。
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ROOT_URL = pathToFileURL(ROOT).href
const ALIASES = [
  ['@core/', 'src/core/'],
  ['@shared/', 'src/shared/']
]

export function resolve(specifier, context, nextResolve) {
  for (const [prefix, dir] of ALIASES) {
    if (!specifier.startsWith(prefix)) {
      continue
    }
    const base = specifier.slice(prefix.length)
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
      const filePath = join(ROOT, dir, candidate)
      if (isFile(filePath)) {
        return { url: pathToFileURL(filePath).href, shortCircuit: true }
      }
    }
    throw new Error(`路径别名解析失败: ${specifier}`)
  }

  const parentURL = context.parentURL
  if (
    parentURL !== undefined &&
    parentURL !== null &&
    parentURL.startsWith(ROOT_URL) &&
    (specifier.startsWith('./') || specifier.startsWith('../'))
  ) {
    const parentDir = dirname(fileURLToPath(parentURL))
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      const filePath = join(parentDir, candidate)
      if (isFile(filePath)) {
        return { url: pathToFileURL(filePath).href, shortCircuit: true }
      }
    }
  }

  return nextResolve(specifier, context)
}

function isFile(filePath) {
  try {
    return existsSync(filePath) && statSync(filePath).isFile()
  } catch {
    return false
  }
}
