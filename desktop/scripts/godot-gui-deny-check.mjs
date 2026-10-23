#!/usr/bin/env node
// 非 headless 下的静默拦截检查（2026-10-23 起插件已无任何提示界面，本脚本取代旧的门控界面检查）。
//
// 覆盖两条只在 GUI 模式成立的路径（headless 分支由 vitest 的 godot-deny-path.test.ts 覆盖）：
// 1. 无授权 + 测试公钥：程序静默退出码 1——无弹窗、无界面、无任何插件输出，且快速退出不挂起；
// 2. 有效授权（测试密钥手签容器放到工程根目录）：进程不被拦截，持续运行（由超时终止证明），
//    同样没有任何插件输出。
//
// 用法：GODOT_BIN=".../Godot_v4.6.3-stable_win64_console.exe" node scripts/godot-gui-deny-check.mjs
import { spawnSync } from 'node:child_process'
import { constants, createHash, createPublicKey, createSign } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const godotBin = process.env.GODOT_BIN
if (!godotBin || !existsSync(godotBin)) {
  console.error('未找到 Godot 可执行文件，请设置 GODOT_BIN')
  process.exit(2)
}

const DAY = 24 * 60 * 60 * 1000
const source = join(process.cwd(), '..', 'godot')
const keyDir = join(process.cwd(), 'tests', 'fixtures', 'keys')
const workDir = mkdtempSync(join(tmpdir(), 'aegis-gui-silent-'))
const projectDir = join(workDir, 'project')
const projectName = `aegis-silent-${process.pid}`

const vendorPem = readFileSync(join(keyDir, 'vendor-test.private.pem'), 'utf8')
const delegatePem = readFileSync(join(keyDir, 'delegate-test.private.pem'), 'utf8')

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
      license_id: 'VND-SILENT-0001',
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
      license_id: 'MCH-SILENT-0001',
      control_license_id: 'VND-SILENT-0001',
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

cpSync(source, projectDir, {
  recursive: true,
  filter: (src) => {
    const base = src.split(/[\\/]/).pop() ?? ''
    return base !== '.godot' && base !== 'addons.zip' && base !== 'license.dat' && base !== 'control.cert'
  }
})

// 写入测试厂商公钥（仅本临时副本；生产插件必须保持空占位）
const jwk = createPublicKey(vendorPem).export({ format: 'jwk' })
writeFileSync(
  join(projectDir, 'addons', 'aegis', 'aegis_vendor_key.gd'),
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

const baseProject = `config_version=5

[application]

config/name="${projectName}"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.6", "Forward Plus")

[autoload]

Aegis="*res://addons/aegis/aegis.gd"
`
writeFileSync(join(projectDir, 'project.godot'), baseProject, 'utf8')

// 用编辑器二进制取项目 ID / 设备 ID（临时去掉 autoload，避免守卫先拦截退出）
const projectFile = join(projectDir, 'project.godot')
const discoverProbe = join(projectDir, 'discover.gd')
writeFileSync(
  discoverProbe,
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
writeFileSync(projectFile, baseProject.replace('Aegis="*res://addons/aegis/aegis.gd"\n', ''), 'utf8')
const discover = spawnSync(godotBin, ['--headless', '--path', projectDir, '-s', 'discover.gd'], {
  encoding: 'utf8',
  timeout: 60_000
})
writeFileSync(projectFile, baseProject, 'utf8')
const discoverOutput = `${discover.stdout ?? ''}\n${discover.stderr ?? ''}`
const projectCode = discoverOutput.match(/PROJECT=(\S+)/)?.[1]
const deviceId = discoverOutput.match(/DEVICE=(\S+)/)?.[1]
if (!projectCode || !deviceId) {
  console.error('无法读取项目 ID / 设备 ID：\n' + discoverOutput)
  process.exit(2)
}

// 场景 1：无授权 → 静默退出码 1
const denied = spawnSync(godotBin, ['--path', projectDir], { encoding: 'utf8', timeout: 20_000 })
const deniedOutput = `${denied.stdout ?? ''}\n${denied.stderr ?? ''}`

// 场景 2：有效授权（测试密钥手签容器放工程根目录）→ 不拦截、持续运行（由超时终止证明）
writeFileSync(join(projectDir, 'license.dat'), buildContainer(projectCode, deviceId), 'utf8')
const started = Date.now()
const licensed = spawnSync(godotBin, ['--path', projectDir], { encoding: 'utf8', timeout: 8_000 })
const licensedElapsed = Date.now() - started
const licensedOutput = `${licensed.stdout ?? ''}\n${licensed.stderr ?? ''}`

const checks = {
  denied_exit_1: denied.status === 1,
  denied_silent: !/\[Aegis\]|授权/.test(deniedOutput),
  licensed_not_denied: licensed.status !== 1,
  licensed_running: licensed.status === null,
  licensed_silent: !/\[Aegis\]|授权/.test(licensedOutput),
  no_script_error: !/SCRIPT ERROR|Parse Error/.test(deniedOutput + licensedOutput)
}

console.log(
  '场景 1（无授权）:',
  JSON.stringify({ status: denied.status, signal: denied.signal })
)
console.log(
  '场景 2（有效授权）:',
  JSON.stringify({ status: licensed.status, signal: licensed.signal, elapsedMs: licensedElapsed })
)
console.log('\nRESULT', JSON.stringify(checks))
try {
  rmSync(workDir, { recursive: true, force: true })
} catch {
  console.log('（临时目录暂未清理：' + workDir + '）')
}

if (Object.values(checks).some((value) => value !== true)) {
  process.exit(1)
}
