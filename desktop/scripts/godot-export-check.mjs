#!/usr/bin/env node
// Windows 导出的验收准备检查（不依赖真实签发端）。
//
// 明确区分四件事，本脚本只覆盖前三件：
//   A. 导出构建成功            → 两次 Release 导出（原始工程 / 装入测试公钥的副本）
//   B. 授权失败拦截通过        → 原始工程导出后无授权 + 空厂商公钥：headless 静默退出码 1（无任何输出）
//   C. 测试授权链通过          → 副本导出后把测试密钥签的 license.dat 放到 exe 同目录：放行且不退出
//   D. 生产协议互通            → 本脚本不覆盖；需要中控侧统一 schema_version 后用正式签发数据验证
//
// 用法：GODOT_BIN=".../Godot_v4.6.3-stable_win64_console.exe" node scripts/godot-export-check.mjs
import { spawnSync } from 'node:child_process'
import { constants, createHash, createPublicKey, createSign } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const godotBin = process.env.GODOT_BIN
if (!godotBin || !existsSync(godotBin)) {
  console.error('未找到 Godot 可执行文件，请设置 GODOT_BIN')
  process.exit(2)
}

const PRESET = 'Windows Desktop'
const DAY = 24 * 60 * 60 * 1000
const source = join(process.cwd(), '..', 'godot')
const keyDir = join(process.cwd(), 'tests', 'fixtures', 'keys')
const workDir = mkdtempSync(join(tmpdir(), 'aegis-export-'))
const vendorPem = readFileSync(join(keyDir, 'vendor-test.private.pem'), 'utf8')
const delegatePem = readFileSync(join(keyDir, 'delegate-test.private.pem'), 'utf8')

const checks = {}
function check(name, ok, extra) {
  checks[name] = ok
  if (!ok && extra) console.log(`  ✗ ${name}\n${extra}`)
}

function copyProject(target) {
  cpSync(source, target, {
    recursive: true,
    filter: (src) => {
      const base = src.split(/[\\/]/).pop() ?? ''
      return base !== '.godot' && base !== 'addons.zip' && base !== 'license.dat' && base !== 'control.cert'
    }
  })
}

function exportProject(projectDir, exePath) {
  const started = Date.now()
  const result = spawnSync(godotBin, ['--headless', '--path', projectDir, '--export-release', PRESET, exePath], {
    encoding: 'utf8',
    timeout: 300_000
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return { status: result.status, output, elapsedMs: Date.now() - started }
}

/** 控制台包装器优先（GUI 子系统 exe 抓不到 stdout） */
function consoleExe(exePath) {
  const candidate = exePath.replace(/\.exe$/i, '.console.exe')
  return existsSync(candidate) ? candidate : exePath
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function iso(offsetMs) {
  return `${new Date(Date.now() + offsetMs).toISOString().slice(0, 19)}Z`
}

function envelope(payloadText, licenseType, pem) {
  const payloadBytes = Buffer.from(payloadText, 'utf8')
  const signature = createSign('RSA-SHA256')
    .update(payloadBytes)
    .sign({ key: pem, padding: constants.RSA_PKCS1_PADDING })
  const kid = b64url(createHash('sha256').update(createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest())
  return JSON.stringify({
    aegis: 'license-envelope',
    schema_version: 1,
    license_type: licenseType,
    alg: 'RS256',
    kid,
    payload: b64url(payloadBytes),
    signature: b64url(signature)
  })
}

function buildContainer(projectCode, deviceId) {
  const delegatedJwk = createPublicKey(delegatePem).export({ format: 'jwk' })
  const control = envelope(
    JSON.stringify({
      schema_version: 1,
      license_type: 'vendor-control',
      license_id: 'VND-EXPORT-0001',
      issued_at: iso(-DAY),
      expires_at: iso(365 * DAY),
      project_ids: [projectCode],
      max_devices: 10,
      features: [],
      delegated_public_key: { kty: 'RSA', n: delegatedJwk.n, e: delegatedJwk.e }
    }),
    'vendor-control',
    vendorPem
  )
  const license = envelope(
    JSON.stringify({
      schema_version: 1,
      license_type: 'machine-license',
      license_id: 'MCH-EXPORT-0001',
      control_license_id: 'VND-EXPORT-0001',
      project_id: projectCode,
      device_id: deviceId,
      issued_at: iso(-3600 * 1000),
      expires_at: iso(90 * DAY),
      status: 'active',
      features: []
    }),
    'machine-license',
    delegatePem
  )
  return JSON.stringify({ v: 1, license, control })
}

function runExe(exePath, timeoutMs) {
  const started = Date.now()
  const result = spawnSync(exePath, ['--headless'], { encoding: 'utf8', timeout: timeoutMs })
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    elapsedMs: Date.now() - started
  }
}

// ---------- A1 + B：原始工程（空厂商公钥）导出并运行 ----------
const denyDir = join(workDir, 'deny')
mkdirSync(denyDir, { recursive: true })
const denyExport = exportProject(source, join(denyDir, 'AegisDeny.exe'))
const denyExe = join(denyDir, 'AegisDeny.exe')
console.log('导出（原始工程）:', denyExport.status, `${denyExport.elapsedMs}ms`)
check('export_plain_ok', denyExport.status === 0 && existsSync(denyExe), denyExport.output.slice(-2000))

if (existsSync(denyExe)) {
  const run = runExe(consoleExe(denyExe), 60_000)
  console.log('运行（无授权 + 空公钥）:', JSON.stringify({ status: run.status, elapsedMs: run.elapsedMs }))
  check('deny_exit_1', run.status === 1, run.output.slice(-2000))
  // 2026-10-23 起插件完全静默：不打印错误码，失败只体现在退出码
  check('deny_silent', !/\[Aegis\]/.test(run.output), run.output.slice(-2000))
  check('deny_no_hang', run.elapsedMs < 30_000)
}

// ---------- A2 + C：装入测试公钥的副本，导出后放测试授权 ----------
const keyedDir = join(workDir, 'keyed')
copyProject(keyedDir)
const jwk = createPublicKey(vendorPem).export({ format: 'jwk' })
writeFileSync(
  join(keyedDir, 'addons', 'aegis', 'aegis_vendor_key.gd'),
  `extends RefCounted
const VENDOR_PUBLIC_KEY := {
	"kty": "RSA",
	"n": "${jwk.n}",
	"e": "${jwk.e}"
}

static func is_configured() -> bool:
	var modulus = VENDOR_PUBLIC_KEY.get("n", "")
	return typeof(modulus) == TYPE_STRING and not String(modulus).is_empty()
`,
  'utf8'
)

const okDir = join(workDir, 'ok')
mkdirSync(okDir, { recursive: true })
const okExport = exportProject(keyedDir, join(okDir, 'AegisOk.exe'))
const okExe = join(okDir, 'AegisOk.exe')
console.log('导出（测试公钥副本）:', okExport.status, `${okExport.elapsedMs}ms`)
check('export_keyed_ok', okExport.status === 0 && existsSync(okExe), okExport.output.slice(-2000))

if (existsSync(okExe)) {
  // 取项目 ID / 设备 ID：用编辑器二进制跑探针（导出包里没有探针脚本）
  const probe = join(keyedDir, 'discover.gd')
  writeFileSync(
    probe,
    `extends SceneTree
const License := preload("res://addons/aegis/aegis_license.gd")
const Device := preload("res://addons/aegis/aegis_device.gd")


func _init() -> void:
	var pc := License.project_code()
	print("PROJECT=" + pc)
	print("DEVICE=" + Device.device_id(pc))
	quit(0)
`,
    'utf8'
  )
  const projectFile = join(keyedDir, 'project.godot')
  const original = readFileSync(projectFile, 'utf8')
  writeFileSync(projectFile, original.replace(/^Aegis="\*res:\/\/addons\/aegis\/aegis\.gd"\r?\n/m, ''), 'utf8')
  const discover = spawnSync(godotBin, ['--headless', '--path', keyedDir, '-s', 'discover.gd'], {
    encoding: 'utf8',
    timeout: 120_000
  })
  writeFileSync(projectFile, original, 'utf8')
  const discoverOutput = `${discover.stdout ?? ''}\n${discover.stderr ?? ''}`
  const projectCode = discoverOutput.match(/PROJECT=(\S+)/)?.[1]
  const deviceId = discoverOutput.match(/DEVICE=(\S+)/)?.[1]
  check('discover_ok', Boolean(projectCode && deviceId), discoverOutput.slice(-1000))

  if (projectCode && deviceId) {
    writeFileSync(join(okDir, 'license.dat'), buildContainer(projectCode, deviceId), 'utf8')
    const withLicense = runExe(consoleExe(okExe), 8_000)
    console.log('运行（测试授权 + 测试公钥）:', JSON.stringify({ status: withLicense.status, elapsedMs: withLicense.elapsedMs }))
    // 插件静默：放行 = 无任何插件输出 + 进程持续运行（被 8 秒超时终止）
    check('chain_silent', !/\[Aegis\]/.test(withLicense.output), withLicense.output.slice(-2000))
    check('chain_not_denied', withLicense.status !== 1, withLicense.output.slice(-2000))
    check('chain_running', withLicense.status === null)
  }
}

console.log('\nRESULT', JSON.stringify(checks))
console.log('产物目录:', workDir)
if (Object.values(checks).some((value) => value !== true)) {
  process.exit(1)
}
if (process.env.AEGIS_KEEP_EXPORT !== '1') {
  rmSync(workDir, { recursive: true, force: true })
}
