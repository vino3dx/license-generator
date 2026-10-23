#!/usr/bin/env node
// 把验签核心从 tests/integration/verifier-godot/ 同步进 Godot 插件目录。
//
// 目的：RSA 核心与严格 JSON 解析器只有一份可维护源（tests/integration/verifier-godot/），
// 插件里的副本是生成物，不允许手工修改，避免两份实现漂移。
//
// 用法：npm run godot:sync
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const sourceDir = join(root, '..', 'tests', 'integration', 'verifier-godot')
const targetDir = join(root, '..', 'godot', 'addons', 'aegis')

const files = [
  {
    source: 'aegis_rsa_verify.gd',
    target: 'aegis_rsa_verify.gd',
    replacements: [
      ['preload("res://aegis_strict_json.gd")', 'preload("res://addons/aegis/aegis_strict_json.gd")'],
      [
        'preload("res://aegis_rsa_verify.gd")',
        'preload("res://addons/aegis/aegis_rsa_verify.gd")'
      ]
    ]
  },
  {
    source: 'aegis_strict_json.gd',
    target: 'aegis_strict_json.gd',
    replacements: []
  }
]

for (const entry of files) {
  const sourcePath = join(sourceDir, entry.source)
  let content = readFileSync(sourcePath, 'utf8')
  for (const [from, to] of entry.replacements) {
    if (!content.includes(from)) {
      console.error(`[sync] ${entry.source} 中找不到预期片段：${from}`)
      process.exit(1)
    }
    content = content.replaceAll(from, to)
  }
  const header =
    `# 自动生成，请勿手工修改。\n` +
    `# 源文件：tests/integration/verifier-godot/${entry.source}\n` +
    `# 重新生成：cd desktop && npm run godot:sync\n`
  const targetPath = join(targetDir, entry.target)
  writeFileSync(targetPath, header + content, 'utf8')
  console.log(`[sync] ${entry.source} -> ${targetPath}`)
}
