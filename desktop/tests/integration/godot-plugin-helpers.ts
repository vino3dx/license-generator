import { spawn, spawnSync } from 'node:child_process'
import { createHash, createPublicKey, type KeyObject } from 'node:crypto'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { join, relative, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { formatTimestamp } from '@core/license/encoding'
import { createEnvelope } from '@core/license/envelope'
import { exportPublicKeyParams } from '@core/license/rsa-keys'
import type { LicenseType } from '@shared/license/protocol'

/**
 * Godot 插件集成测试公共件。
 *
 * 载荷按**插件验签器当前接受的 v1 字段集**（含 `features`）手工构造并用测试私钥签名。
 * 背景：P1 源码已升级到 v3（payload 内嵌 `control_cert`、去掉 `features`），而插件侧的
 * `aegis_rsa_verify.gd`（由 tests/integration/verifier-godot 生成的 v1 版本）仍按 v1 字段集校验，
 * 两端暂不互通；因此这里不直接用 `@core/services` 的签发器构造载荷。
 * 端到端互通需先统一协议实现，属协议决策，不在工程整理范围内（见 docs/license-protocol.md 与验收报告）。
 */

export const GODOT_BIN = process.env.GODOT_BIN ?? ''
export const hasGodot = GODOT_BIN.length > 0 && existsSync(GODOT_BIN)
export const godotSource = join(process.cwd(), '..', 'godot')
/** 分发包由 scripts 生成到仓库级 releases/，不再放在源码目录 */
export const addonsZip = join(process.cwd(), '..', 'releases', 'aegis-addon-v3.zip')
export const DAY_MS = 24 * 60 * 60 * 1000
export const PYTHON = process.env.PYTHON ?? 'python'

export interface RunResult {
  status: number | null
  output: string
  elapsedMs: number
}

export function iso(offsetMs: number, base = Date.now()): string {
  return formatTimestamp(new Date(base + offsetMs))
}

/** 把 godot/ 工程复制到临时目录，排除缓存、旧授权文件与分发包 */
export function copyProject(target: string): void {
  cpSync(godotSource, target, {
    recursive: true,
    filter: (src) => {
      const base = src.split(/[\\/]/).pop() ?? ''
      if (base === '.godot' || base === 'build' || base === 'addons.zip') return false
      if (base === 'license.dat' || base === 'control.cert') return false
      return true
    }
  })
}

export function vendorKeyScript(params: { n: string; e: string } | null): string {
  const n = params ? params.n : ''
  const e = params ? params.e : 'AQAB'
  return `extends RefCounted
const VENDOR_PUBLIC_KEY := {
	"kty": "RSA",
	"n": "${n}",
	"e": "${e}"
}

static func is_configured() -> bool:
	var modulus = VENDOR_PUBLIC_KEY.get("n", "")
	return typeof(modulus) == TYPE_STRING and not String(modulus).is_empty()
`
}

export function writeVendorKey(projectDir: string, key: KeyObject | null): void {
  const params = key ? exportPublicKeyParams(key) : null
  writeFileSync(join(projectDir, 'addons', 'aegis', 'aegis_vendor_key.gd'), vendorKeyScript(params), 'utf8')
}

export interface VendorOptions {
  licenseId?: string
  issuedAt: string
  expiresAt: string
  projectIds: string[]
  maxDevices?: number
  delegated: { kty: string; n: string; e: string }
}

/** 协议冻结稿的 vendor-control payload 文本（字段顺序即协议顺序） */
export function vendorPayloadText(options: VendorOptions): string {
  return JSON.stringify({
    schema_version: 1,
    license_type: 'vendor-control',
    license_id: options.licenseId ?? 'VND-TEST-0001',
    issued_at: options.issuedAt,
    expires_at: options.expiresAt,
    project_ids: options.projectIds,
    max_devices: options.maxDevices ?? 50,
    features: [],
    delegated_public_key: options.delegated
  })
}

export interface MachineOptions {
  licenseId?: string
  controlLicenseId: string
  projectId: string
  deviceId: string
  issuedAt: string
  expiresAt: string
  status?: 'active' | 'revoked'
}

/** 协议冻结稿的 machine-license payload 文本 */
export function machinePayloadText(options: MachineOptions): string {
  return JSON.stringify({
    schema_version: 1,
    license_type: 'machine-license',
    license_id: options.licenseId ?? 'MCH-TEST-0001',
    control_license_id: options.controlLicenseId,
    project_id: options.projectId,
    device_id: options.deviceId,
    issued_at: options.issuedAt,
    expires_at: options.expiresAt,
    status: options.status ?? 'active',
    features: []
  })
}

/**
 * 插件验签器接受的协议版本。
 *
 * `desktop/src/shared/license/protocol.ts` 里 `LICENSE_SCHEMA_VERSION = 3`
 * （machine payload 用 `control_cert`、无 `features`），而插件内的
 * `aegis_rsa_verify.gd` 是生成物、只接受版本 1 且要求 `features` 字段。
 * 两边口径不一致，属于跨模块协议冲突（已单独报告），
 * 这里按插件侧已冻结的口径（协议文档 v1）构造测试向量。
 * 信封本身不参与签名，改写 schema_version 不影响签名有效性。
 */
export const ENVELOPE_SCHEMA_VERSION = 1

export function signPayload(text: string | Buffer, type: LicenseType, key: KeyObject): string {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text
  const envelope = JSON.parse(createEnvelope(bytes, type, key)) as Record<string, unknown>
  envelope['schema_version'] = ENVELOPE_SCHEMA_VERSION
  return JSON.stringify(envelope)
}

export function buildContainer(licenseEnvelope: string, controlEnvelope: string): string {
  return JSON.stringify({ v: 1, license: licenseEnvelope, control: controlEnvelope })
}

export interface Chain {
  control: string
  license: string
  container: string
  controlLicenseId: string
  licenseId: string
  machinePayload: string
  vendorPayload: string
}

export interface ChainOptions {
  projectId: string
  deviceId: string
  vendorKey: KeyObject
  delegateKey: KeyObject
  control?: Partial<VendorOptions>
  machine?: Partial<MachineOptions>
  /** 覆盖子机授权签名密钥（用于构造错误委托私钥） */
  licenseSigner?: KeyObject
  /** 改写 payload 文本后再签名（构造「签名有效但内容非法」的用例） */
  mutateMachine?: (text: string) => string
  mutateVendor?: (text: string) => string
}

/** 签发一条完整信任链（测试私钥，产物只写在临时目录） */
export function buildChain(options: ChainOptions): Chain {
  const now = Date.now()
  // 委托公钥必须与签发子机授权的私钥配对
  const delegated = exportPublicKeyParams(createPublicKey(options.delegateKey))
  const vendorOptions: VendorOptions = {
    licenseId: 'VND-TEST-0001',
    issuedAt: iso(-DAY_MS, now),
    expiresAt: iso(365 * DAY_MS, now),
    projectIds: [options.projectId],
    maxDevices: 50,
    delegated,
    ...options.control
  }
  let vendorPayload = vendorPayloadText(vendorOptions)
  if (options.mutateVendor) vendorPayload = options.mutateVendor(vendorPayload)
  const control = signPayload(vendorPayload, 'vendor-control', options.vendorKey)

  const machineOptions: MachineOptions = {
    controlLicenseId: options.control?.licenseId ?? 'VND-TEST-0001',
    projectId: options.projectId,
    deviceId: options.deviceId,
    issuedAt: iso(-60 * 60 * 1000, now),
    expiresAt: iso(90 * DAY_MS, now),
    status: 'active',
    ...options.machine
  }
  let machinePayload = machinePayloadText(machineOptions)
  if (options.mutateMachine) machinePayload = options.mutateMachine(machinePayload)
  const license = signPayload(machinePayload, 'machine-license', options.licenseSigner ?? options.delegateKey)

  return {
    control,
    license,
    container: buildContainer(license, control),
    controlLicenseId: vendorOptions.licenseId ?? 'VND-TEST-0001',
    licenseId: machineOptions.licenseId ?? 'MCH-TEST-0001',
    machinePayload,
    vendorPayload
  }
}

/** 写入/清除 license.dat：内容由调用方决定（容器、裸信封或损坏文本） */
export function writeLicense(dir: string, content: string | null): void {
  const target = join(dir, 'license.dat')
  if (content === null) {
    rmSync(target, { force: true })
    return
  }
  writeFileSync(target, content, 'utf8')
}

/** 旧版两文件布局里的 control.cert：新版只用于识别旧格式 */
export function writeLegacyControl(dir: string, content: string | null): void {
  const target = join(dir, 'control.cert')
  if (content === null) {
    rmSync(target, { force: true })
    return
  }
  writeFileSync(target, content, 'utf8')
}

export function runScript(
  projectDir: string,
  script: string,
  extraArgs: string[] = [],
  timeoutMs = 60_000
): RunResult {
  const args = ['--headless', '--path', projectDir, '-s', script]
  if (extraArgs.length > 0) args.push('--', ...extraArgs)
  const started = Date.now()
  const result = spawnSync(GODOT_BIN, args, { encoding: 'utf8', timeout: timeoutMs })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    elapsedMs: Date.now() - started
  }
}

/**
 * 异步版脚本运行：必须用它跑网络测试。
 * spawnSync 会阻塞 Node 事件循环，进程内的假中控（TCP/UDP）就没机会 accept 和回包。
 */
export function runScriptAsync(
  projectDir: string,
  script: string,
  extraArgs: string[] = [],
  timeoutMs = 60_000
): Promise<RunResult> {
  const args = ['--headless', '--path', projectDir, '-s', script]
  if (extraArgs.length > 0) args.push('--', ...extraArgs)
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(GODOT_BIN, args)
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, output, elapsedMs: Date.now() - started })
    })
  })
}

/**
 * 异步「运行游戏」：会实例化 autoload 与主场景（不加 --headless，有显示环境 → 走门控界面分支）。
 * onOutput 用于边跑边判断（例如看到某个标记后再启动假中控）。
 */
export function runGameAsync(
  projectDir: string,
  extraArgs: string[] = [],
  timeoutMs = 60_000,
  onOutput?: (all: string) => void
): Promise<RunResult> {
  const args = ['--path', projectDir]
  if (extraArgs.length > 0) args.push('--', ...extraArgs)
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(GODOT_BIN, args)
    let output = ''
    const push = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      onOutput?.(output)
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, output, elapsedMs: Date.now() - started })
    })
  })
}

export interface ReplyOptions {
  status?: 'issued' | 'unchanged' | 'denied'
  license?: string
  reason?: string | null
  nonce?: string | null
  rawLine?: string
  closeAfter?: boolean
}

export interface FakeHub {
  port: number
  requests: string[]
  close: () => Promise<void>
}

/**
 * 进程内假中控（TCP 一问一答）。
 * port 传 0 时由系统分配，返回真实端口——需要避开固定端口的用例用这个，
 * 服务端关闭后不再接受连接。
 */
export async function startTcpHub(
  port: number,
  reply: (request: string) => ReplyOptions
): Promise<FakeHub> {
  const requests: string[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket)
    let buffer = ''
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const index = buffer.indexOf('\n')
      if (index < 0) return
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      requests.push(line)
      const parsed = JSON.parse(line) as { nonce?: string }
      const options = reply(line)
      const payload = {
        v: 1,
        status: options.status ?? 'issued',
        license: options.license ?? '',
        reason: options.reason ?? null,
        nonce: options.nonce ?? parsed.nonce ?? ''
      }
      socket.write(`${options.rawLine ?? JSON.stringify(payload)}\n`)
      if (options.closeAfter !== false) socket.end()
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const actualPort = (server.address() as AddressInfo).port
  return {
    port: actualPort,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

/** 以「运行游戏」方式启动（会执行 autoload，用于失败拦截测试） */
export function runGame(projectDir: string, timeoutMs = 30_000): RunResult {
  const started = Date.now()
  const result = spawnSync(GODOT_BIN, ['--headless', '--path', projectDir], {
    encoding: 'utf8',
    timeout: timeoutMs
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    elapsedMs: Date.now() - started
  }
}

/** 读取 zip 中央目录并解压全部条目（仅支持 stored / deflate） */
export function readZipEntries(file: string): Map<string, Buffer> {
  const buffer = readFileSync(file)
  let eocd = -1
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP 缺少中央目录结尾记录')
  const total = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map<string, Buffer>()
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录条目损坏')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export function listSourceFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return files.sort()
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}
