#!/usr/bin/env node
// 厂商根签发（Master Issuer）CLI：
//   1. 加载或生成厂商根私钥（RSA-2048，RS256）
//   2. 生成委托密钥对，把委托公钥写入 control.cert payload
//   3. 签发 v3 规范 control.cert（硬编码 max_devices / project_ids / expires_at）
//   4. 导出委托私钥 PEM，供 P1 中控导入
//   5. 自检：验签回读 + 过期拒绝（负向用例）
//
// 用法：
//   npm run master:issue -- --license-id VND-2026-001 --max-devices 50 \
//     --project-ids proj-alpha,proj-beta [--ttl-days 30 | --expires-at 2026-11-22T00:00:00Z] \
//     [--vendor-key path/to/vendor-root-private.pem] [--out-dir tools/master-issuer/out]
//
// 复用 --vendor-key 时不生成新根密钥；--project-ids 传 "*" 表示不限项目。
// 密码学逻辑全部来自 src/core/license，本脚本只做参数解析、落盘与自检。
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { KeyObject } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeKeyId,
  derivePublicKey,
  exportPrivateKeyPem,
  exportPublicKeyParams,
  generateRsaPrivateKey,
  issueVendorCertificate,
  isLicenseError,
  loadPrivateKeyFromPem,
  verifyVendorCertificate
} from '@core/license'
import { formatTimestamp, isIdentifier, isTimestamp } from '@core/license/encoding'

interface MasterIssueOptions {
  readonly licenseId: string
  readonly maxDevices: number
  readonly projectIds: readonly string[]
  readonly expiresAt: string
  readonly outDir: string
  readonly vendorKeyPath: string | null
}

const DEFAULT_TTL_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

function main(): void {
  const options = parseOptions(process.argv.slice(2))
  const now = new Date()
  const issuedAt = formatTimestamp(now)

  // 1. 厂商根私钥：复用或生成
  let vendorPrivateKey: KeyObject
  let generatedVendorKey: KeyObject | null = null
  if (options.vendorKeyPath !== null) {
    vendorPrivateKey = readPrivateKeyFile(options.vendorKeyPath)
    console.log(`[1/5] 复用厂商根私钥: ${options.vendorKeyPath}`)
  } else {
    generatedVendorKey = generateRsaPrivateKey()
    vendorPrivateKey = generatedVendorKey
    console.log(`[1/5] 已生成新的厂商根私钥（RSA-2048）`)
  }

  // 2. 委托密钥对：本次签发独立生成，公钥进入证书，私钥导出给 P1
  const delegatedPrivateKey = generateRsaPrivateKey()
  const delegatedPublicKey = derivePublicKey(delegatedPrivateKey)
  const delegatedPublicKeyParams = exportPublicKeyParams(delegatedPublicKey)
  const delegatedKeyId = computeKeyId(delegatedPublicKey)
  console.log(`[2/5] 已生成委托密钥对 (kid=${delegatedKeyId.slice(0, 12)}…)`)

  // 3. 签发中控证书：额度/范围/过期时间写入 payload 并签名
  const issued = issueVendorCertificate(
    {
      licenseId: options.licenseId,
      issuedAt,
      expiresAt: options.expiresAt,
      projectIds: options.projectIds,
      maxDevices: options.maxDevices,
      delegatedPublicKey: delegatedPublicKeyParams
    },
    vendorPrivateKey
  )
  console.log(`[3/5] control.cert 已签发 (license_id=${issued.payload.license_id})`)

  // 4. 落盘
  const vendorPublicKey = derivePublicKey(vendorPrivateKey)
  const vendorPublicKeyParams = exportPublicKeyParams(vendorPublicKey)
  const outDir = options.outDir
  mkdirSync(outDir, { recursive: true })
  writeFile(join(outDir, 'control.cert'), issued.envelope, 'utf8')
  if (generatedVendorKey !== null) {
    writePrivateFile(join(outDir, 'vendor-root-private.pem'), exportPrivateKeyPem(generatedVendorKey))
  }
  writeJsonFile(join(outDir, 'vendor-root-public.json'), {
    kid: computeKeyId(vendorPublicKey),
    ...vendorPublicKeyParams
  })
  writePrivateFile(join(outDir, 'delegated-private.pem'), exportPrivateKeyPem(delegatedPrivateKey))
  writeJsonFile(join(outDir, 'delegated-public.json'), { kid: delegatedKeyId, ...delegatedPublicKeyParams })
  console.log(`[4/5] 产物已写入 ${outDir}`)

  // 5. 自检：正常验签 + 委托公钥一致性 + 过期拒绝
  const verified = verifyVendorCertificate(issued.envelope, vendorPublicKey)
  if (verified.delegatedKeyId !== delegatedKeyId) {
    throw new Error('自检失败：证书内委托公钥与本次生成的委托密钥不一致')
  }
  const expiredCheckMs = verified.expiresAt + 60_000
  let expiredRejected = false
  try {
    verifyVendorCertificate(issued.envelope, vendorPublicKey, expiredCheckMs)
  } catch (error) {
    expiredRejected = isLicenseError(error) && error.code === 'expired'
    if (!expiredRejected) {
      throw error
    }
  }
  if (!expiredRejected) {
    throw new Error('自检失败：过期证书未被拒绝')
  }
  console.log(`[5/5] 自检通过：验签成功、委托密钥一致、过期后按 'expired' 拒绝`)

  console.log('')
  console.log('license_id    :', issued.payload.license_id)
  console.log('issued_at     :', issued.payload.issued_at)
  console.log('expires_at    :', issued.payload.expires_at)
  console.log('max_devices   :', issued.payload.max_devices)
  console.log('project_ids   :', issued.payload.project_ids.join(', '))
  console.log('control kid   :', verified.controlKeyId)
  console.log('delegated kid :', delegatedKeyId)
  console.log('')
  console.log('下一步：')
  console.log('  - P1 中控：通过「委托私钥导入」导入 delegated-private.pem')
  console.log('  - P1/P2 信任根：用 vendor-root-public.json（构建期嵌入或 AEGIS_VENDOR_PUBLIC_KEY 注入）')
  if (generatedVendorKey !== null) {
    console.log('  - vendor-root-private.pem 是信任根私钥，离线妥善保存，不要分发到客户环境')
  }
}

function parseOptions(argv: readonly string[]): MasterIssueOptions {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith('--')) {
      throw new Error(`无法识别的参数: ${String(arg)}`)
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数 ${arg} 缺少值`)
    }
    args.set(arg.slice(2), value)
    i++
  }

  const licenseId = requireValue(args, 'license-id')
  if (!isIdentifier(licenseId)) {
    throw new Error('--license-id 只能包含字母/数字/._:-，长度 1..128')
  }

  const maxDevicesText = requireValue(args, 'max-devices')
  const maxDevices = Number(maxDevicesText)
  if (!Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 1_000_000) {
    throw new Error('--max-devices 必须是 1..1000000 的整数')
  }

  const projectIds = requireValue(args, 'project-ids')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (projectIds.length === 0) {
    throw new Error('--project-ids 不能为空（多个用逗号分隔，不限项目传 "*"）')
  }

  const expiresAtText = args.get('expires-at')
  const ttlDaysText = args.get('ttl-days')
  let expiresAt: string
  if (expiresAtText !== undefined) {
    if (ttlDaysText !== undefined) {
      throw new Error('--expires-at 与 --ttl-days 只能二选一')
    }
    if (!isTimestamp(expiresAtText)) {
      throw new Error('--expires-at 格式必须为 YYYY-MM-DDTHH:MM:SSZ')
    }
    expiresAt = expiresAtText
  } else {
    const ttlDays = ttlDaysText === undefined ? DEFAULT_TTL_DAYS : Number(ttlDaysText)
    if (!Number.isSafeInteger(ttlDays) || ttlDays < 1) {
      throw new Error('--ttl-days 必须是正整数（默认 30 天）')
    }
    expiresAt = formatTimestamp(new Date(Date.now() + ttlDays * DAY_MS))
  }

  const vendorKeyPath = args.get('vendor-key') ?? null
  if (vendorKeyPath !== null && !isAbsolute(vendorKeyPath)) {
    throw new Error('--vendor-key 请使用绝对路径，避免依赖当前目录')
  }

  // 默认落在工具自己的 out/ 下（P0 产物不写进 desktop/），可用 --out-dir 覆盖
  const defaultOutDir = resolve(dirname(fileURLToPath(import.meta.url)), 'out')
  const outDirRaw = args.get('out-dir') ?? defaultOutDir
  return {
    licenseId,
    maxDevices,
    projectIds,
    expiresAt,
    outDir: isAbsolute(outDirRaw) ? outDirRaw : resolve(outDirRaw),
    vendorKeyPath
  }
}

function requireValue(args: Map<string, string>, name: string): string {
  const value = args.get(name)
  if (value === undefined) {
    throw new Error(`缺少必需参数 --${name}`)
  }
  return value
}

function readPrivateKeyFile(path: string): ReturnType<typeof loadPrivateKeyFromPem> {
  return loadPrivateKeyFromPem(readFileSync(path, 'utf8'))
}

function writeFile(path: string, content: string, encoding: BufferEncoding): void {
  writeFileSync(path, content, { encoding })
}

function writePrivateFile(path: string, pem: string): void {
  writeFileSync(path, `${pem}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows 上 chmod 基本无效，忽略（与委托私钥存储的已知限制一致）
  }
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[master-issuer] 失败: ${message}`)
  process.exit(1)
}
