import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatTimestamp } from '@core/license/encoding'
import { createEnvelope } from '@core/license/envelope'
import { issueMachineLicense, issueVendorCertificate } from '@core/license/index'
import { exportPublicKeyParams } from '@core/license/rsa-keys'
import { loadTestPrivateKey, loadTestPublicKey, makeMachineInput, makeVendorInput } from '../fixtures/test-keys'

/**
 * Aegis Godot 插件：失败拦截 / 时间戳严格性 / 分发包 / 干净工程安装。
 *
 * 与 godot-real-license.test.ts 互补：
 * - 那边验证「授权链判定是否正确」；
 * - 这边验证「判定失败后进程是否真的被拦住」以及「分发包能否直接安装运行」。
 *
 * 需要 GODOT_BIN 指向 Godot 4.6.3 console 版本；未设置时整组跳过。
 */

const GODOT_BIN = process.env.GODOT_BIN ?? ''
const hasGodot = GODOT_BIN.length > 0 && existsSync(GODOT_BIN)
const repoRoot = process.cwd()
const godotSource = join(repoRoot, '..', 'godot')
const zipPath = join(godotSource, 'addons.zip')
const pythonBin = process.env.PYTHON ?? 'python'

const vendorPrivate = loadTestPrivateKey('vendor-test')
const delegatePrivate = loadTestPrivateKey('delegate-test')
const vendorPublicParams = exportPublicKeyParams(loadTestPublicKey('vendor-test'))

const NOW = Date.now()
const iso = (offsetMs: number): string => formatTimestamp(new Date(NOW + offsetMs))
const DAY = 24 * 60 * 60 * 1000

let workDir = ''
let projectDir = ''
let cleanDir = ''
let projectName = ''
let projectCode = ''
let deviceId = ''

const DISCOVER_PROBE = `extends SceneTree
const License := preload("res://addons/aegis/aegis_license.gd")
const Device := preload("res://addons/aegis/aegis_device.gd")

func _init() -> void:
	print("PROJECT=" + License.project_code())
	print("DEVICE=" + Device.device_id())
	quit(0)
`

/** 主场景探针：记录主场景是否真的被执行，以及 is_licensed() 在最早时机是否可用 */
const MAIN_PROBE = `extends Node

var _frames := 0


func _ready() -> void:
	print("MAIN_READY")
	var guard = get_node_or_null("/root/Aegis")
	var licensed := false
	if guard != null:
		licensed = bool(guard.is_licensed())
		for _i in range(5):
			guard._check()
	print("IS_LICENSED=" + str(licensed))


func _process(_delta: float) -> void:
	_frames += 1
	print("MAIN_PROCESS=" + str(_frames))
	if _frames >= 3:
		get_tree().quit(0)
`

const MAIN_SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main_probe.gd" id="1_probe"]

[node name="Main" type="Node"]
script = ExtResource("1_probe")
`

function vendorKeyScript(params: { n: string; e: string } | null): string {
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

interface RunResult {
  status: number | null
  output: string
  elapsedMs: number
}

function runGame(path: string, timeoutMs = 30_000): RunResult {
  const started = Date.now()
  const result = spawnSync(GODOT_BIN, ['--headless', '--path', path], {
    encoding: 'utf8',
    timeout: timeoutMs
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    elapsedMs: Date.now() - started
  }
}

function writeProject(projectPath: string, name: string, withProbe: boolean): void {
  const autoload = 'Aegis="*res://addons/aegis/aegis.gd"'
  const lines = [
    'config_version=5',
    '',
    '[application]',
    '',
    `config/name="${name}"`,
    withProbe ? 'run/main_scene="res://main_probe.tscn"' : 'run/main_scene="res://main.tscn"',
    'config/features=PackedStringArray("4.6", "Forward Plus")',
    '',
    '[autoload]',
    '',
    autoload,
    ''
  ]
  writeFileSync(join(projectPath, 'project.godot'), lines.join('\n'), 'utf8')
  if (withProbe) {
    writeFileSync(join(projectPath, 'main_probe.gd'), MAIN_PROBE, 'utf8')
    writeFileSync(join(projectPath, 'main_probe.tscn'), MAIN_SCENE, 'utf8')
  }
}

function writeLicenseFiles(projectPath: string, control: string | null, license: string | null): void {
  for (const [name, content] of [
    ['control.cert', control],
    ['license.dat', license]
  ] as const) {
    const target = join(projectPath, name)
    if (content === null) {
      if (existsSync(target)) rmSync(target)
    } else {
      writeFileSync(target, content, 'utf8')
    }
  }
}

function issuePair(overrides: {
  control?: Partial<Parameters<typeof makeVendorInput>[0]>
  machine?: Partial<Parameters<typeof makeMachineInput>[0]>
}): { control: string; license: string; controlLicenseId: string } {
  const controlInput = makeVendorInput({
    issuedAt: iso(-DAY),
    expiresAt: iso(365 * DAY),
    projectIds: [projectCode],
    ...overrides.control
  })
  const certificate = issueVendorCertificate(controlInput, vendorPrivate)
  const machineInput = makeMachineInput({
    controlLicenseId: controlInput.licenseId,
    projectId: projectCode,
    deviceId,
    issuedAt: iso(-60 * 60 * 1000),
    expiresAt: iso(90 * DAY),
    ...overrides.machine
  })
  const license = issueMachineLicense(machineInput, delegatePrivate)
  return {
    control: certificate.envelope,
    license: license.envelope,
    controlLicenseId: controlInput.licenseId
  }
}

function validMachinePayloadText(): string {
  return issueMachineLicense(
    makeMachineInput({
      controlLicenseId: 'VND-TEST-0001',
      projectId: projectCode,
      deviceId,
      issuedAt: iso(-60 * 60 * 1000),
      expiresAt: iso(90 * DAY)
    }),
    delegatePrivate
  ).payloadBytes.toString('utf8')
}

/** 对任意 payload 字节签名，用于构造「签名有效但内容畸形」的用例 */
function signMachine(payloadText: string): string {
  return createEnvelope(Buffer.from(payloadText, 'utf8'), 'machine-license', delegatePrivate)
}

/** 读取 zip 中央目录并解压全部条目（仅支持 stored / deflate） */
function readZipEntries(file: string): Map<string, Buffer> {
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

function listSourceFiles(root: string): string[] {
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

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

describe.skipIf(!hasGodot)('Aegis Godot 插件：失败拦截与分发包', () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aegis-godot-deny-'))
    projectDir = join(workDir, 'project')
    cleanDir = join(workDir, 'clean')
    cpSync(godotSource, projectDir, {
      recursive: true,
      filter: (src) => {
        const base = src.split(/[\\/]/).pop() ?? ''
        if (base === '.godot' || base === 'build' || base === 'addons.zip') return false
        if (base === 'license.dat' || base === 'control.cert') return false
        return true
      }
    })
    projectName = `aegis-deny-${process.pid}`
    writeProject(projectDir, projectName, true)
    writeFileSync(join(projectDir, 'addons', 'aegis', 'aegis_vendor_key.gd'), vendorKeyScript(vendorPublicParams), 'utf8')
    writeFileSync(join(projectDir, 'discover.gd'), DISCOVER_PROBE, 'utf8')
    writeLicenseFiles(projectDir, null, null)

    const discover = spawnSync(GODOT_BIN, ['--headless', '--path', projectDir, '-s', 'discover.gd'], {
      encoding: 'utf8',
      timeout: 60_000
    })
    const output = `${discover.stdout ?? ''}\n${discover.stderr ?? ''}`
    const projectMatch = output.match(/PROJECT=(\S+)/)
    const deviceMatch = output.match(/DEVICE=(\S+)/)
    if (!projectMatch?.[1] || !deviceMatch?.[1]) {
      throw new Error(`无法读取项目 ID / 设备 ID：\n${output}`)
    }
    projectCode = projectMatch[1]
    deviceId = deviceMatch[1]
  }, 120_000)

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
    if (process.env.APPDATA) {
      rmSync(join(process.env.APPDATA, 'Godot', 'app_userdata', `aegis-deny-${process.pid}`), {
        recursive: true,
        force: true
      })
    }
  })

  describe('授权失败拦截（headless）', () => {
    it('无授权文件：退出码 1，主场景不进入 _process，is_licensed() 为 false', () => {
      writeLicenseFiles(projectDir, null, null)
      const result = runGame(projectDir)
      // 校验顺序：先中控证书后子机授权，因此两个文件都缺失时报 0x013
      expect(result.output).toContain('[Aegis] 授权校验失败 (Err: 0x013)')
      expect(result.output).toContain('IS_LICENSED=false')
      expect(result.output).not.toContain('MAIN_PROCESS=1')
      expect(result.status).toBe(1)
    })

    it('无授权文件：不等待 GUI、不挂起，10 秒内退出', () => {
      writeLicenseFiles(projectDir, null, null)
      const result = runGame(projectDir, 20_000)
      expect(result.status).toBe(1)
      expect(result.elapsedMs).toBeLessThan(10_000)
    })

    it('重复触发授权失败：只记录一次拒绝，不重复创建弹窗/退出', () => {
      writeLicenseFiles(projectDir, null, null)
      const result = runGame(projectDir)
      const occurrences = result.output.split('[Aegis] 授权校验失败').length - 1
      expect(occurrences).toBe(1)
      expect(result.status).toBe(1)
    })

    it('合法授权：主场景正常执行并自行退出 0', () => {
      const pair = issuePair({})
      writeLicenseFiles(projectDir, pair.control, pair.license)
      const result = runGame(projectDir)
      expect(result.output).toContain('IS_LICENSED=true')
      expect(result.output).toContain('MAIN_PROCESS=3')
      expect(result.status).toBe(0)
    })
  })

  describe('时间戳严格性（签名有效但时间非法）', () => {
    it('子机授权 issued_at 非法日历值：拒绝 0x022 timestamp_invalid', () => {
      const pair = issuePair({})
      const payloadText = validMachinePayloadText().replace(
        /"issued_at":"[^"]*"/,
        '"issued_at":"2027-13-45T00:00:00Z"'
      )
      writeLicenseFiles(projectDir, pair.control, signMachine(payloadText))
      const result = runGame(projectDir)
      expect(result.output).toContain('Err: 0x022 detail=timestamp_invalid')
      expect(result.status).toBe(1)
    })

    it('中控证书 issued_at 非法日历值：拒绝 0x021 timestamp_invalid', () => {
      const controlInput = makeVendorInput({
        issuedAt: iso(-DAY),
        expiresAt: iso(365 * DAY),
        projectIds: [projectCode]
      })
      const certificate = issueVendorCertificate(controlInput, vendorPrivate)
      const badControl = createEnvelope(
        Buffer.from(
          certificate.payloadBytes.toString('utf8').replace(/"issued_at":"[^"]*"/, '"issued_at":"2027-13-45T00:00:00Z"'),
          'utf8'
        ),
        'vendor-control',
        vendorPrivate
      )
      const pair = issuePair({})
      writeLicenseFiles(projectDir, badControl, pair.license)
      const result = runGame(projectDir)
      expect(result.output).toContain('Err: 0x021 detail=timestamp_invalid')
      expect(result.status).toBe(1)
    })
  })

  describe('分发包 addons.zip', () => {
    it('条目与源码目录逐文件一致（含 .uid），不含私钥/缓存/测试产物', () => {
      const entries = readZipEntries(zipPath)
      const zipFiles = [...entries.keys()].filter((name) => !name.endsWith('/')).sort()
      const sourceFiles = listSourceFiles(godotSource).filter((name) => name.startsWith('addons/'))
      expect(zipFiles).toEqual(sourceFiles)
      for (const name of zipFiles) {
        expect(name.startsWith('addons/aegis/')).toBe(true)
        expect(name).not.toMatch(/\.import$|\.pem$|private|__pycache__|\.tmp$/)
        const source = readFileSync(join(godotSource, name))
        expect(sha256(entries.get(name) as Buffer)).toBe(sha256(source))
      }
      // 生产包必须保持空厂商公钥（fail-closed），不能把测试公钥带进分发包
      const vendorKey = (entries.get('addons/aegis/aegis_vendor_key.gd') as Buffer).toString('utf8')
      expect(vendorKey).toContain('"n": ""')
    })

    it('重复执行打包脚本结果稳定（字节级一致）', () => {
      const first = spawnSync(pythonBin, [join(godotSource, 'package_addons.py')], { encoding: 'utf8' })
      expect(first.status).toBe(0)
      const hash1 = sha256(readFileSync(zipPath))
      const second = spawnSync(pythonBin, [join(godotSource, 'package_addons.py')], { encoding: 'utf8' })
      expect(second.status).toBe(0)
      const hash2 = sha256(readFileSync(zipPath))
      expect(hash2).toBe(hash1)
    })
  })

  describe('干净工程安装', () => {
    it('解压后可被编辑器识别（无脚本/插件加载错误）', () => {
      mkdirSync(cleanDir, { recursive: true })
      for (const [name, content] of readZipEntries(zipPath)) {
        if (name.endsWith('/')) continue
        const target = join(cleanDir, name)
        mkdirSync(join(target, '..'), { recursive: true })
        writeFileSync(target, content)
      }
      writeProject(cleanDir, projectName, false)
      const projectText = readFileSync(join(cleanDir, 'project.godot'), 'utf8')
      writeFileSync(
        join(cleanDir, 'project.godot'),
        `${projectText}\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/aegis/plugin.cfg")\n`,
        'utf8'
      )
      const result = spawnSync(GODOT_BIN, ['--headless', '--editor', '--quit', '--path', cleanDir], {
        encoding: 'utf8',
        timeout: 90_000
      })
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      expect(result.status).toBe(0)
      expect(output).not.toMatch(/Failed to load addon|Parse Error|SCRIPT ERROR/)
    }, 120_000)

    it('安装后空公钥仍 fail-closed：退出码 1 且报 0x062', () => {
      writeProject(cleanDir, projectName, true)
      writeLicenseFiles(cleanDir, null, null)
      const result = runGame(cleanDir)
      expect(result.output).toContain('0x062')
      expect(result.status).toBe(1)
    })

    it('安装后配置真实测试公钥与授权：合法链放行', () => {
      writeProject(cleanDir, projectName, true)
      writeFileSync(join(cleanDir, 'addons', 'aegis', 'aegis_vendor_key.gd'), vendorKeyScript(vendorPublicParams), 'utf8')
      const pair = issuePair({})
      writeLicenseFiles(cleanDir, pair.control, pair.license)
      const result = runGame(cleanDir)
      expect(result.output).toContain('IS_LICENSED=true')
      expect(result.status).toBe(0)
    })
  })
})
