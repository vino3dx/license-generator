import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEnvelope } from '@core/license/envelope'
import { formatTimestamp } from '@core/license/encoding'
import { issueMachineLicense, issueVendorCertificate } from '@core/license/index'
import { exportPublicKeyParams } from '@core/license/rsa-keys'
import { loadTestPrivateKey, loadTestPublicKey, makeMachineInput, makeVendorInput } from '../fixtures/test-keys'

/**
 * Node → Godot 真实授权联调。
 *
 * 做法：把 godot/ 工程复制到临时目录，写入测试厂商公钥与真实签发的
 * control.cert / license.dat，再用 Godot 4.6.3 headless 加载插件核心，
 * 读取它输出的错误码。测试密钥与授权文件只存在于临时目录。
 *
 * 需要 GODOT_BIN 指向 Godot 4.6.3 console 版本；未设置时整组跳过。
 */

const GODOT_BIN = process.env.GODOT_BIN ?? ''
const hasGodot = GODOT_BIN.length > 0 && existsSync(GODOT_BIN)
const repoRoot = process.cwd()
const godotSource = join(repoRoot, '..', 'godot')

const vendorPrivate = loadTestPrivateKey('vendor-test')
const delegatePrivate = loadTestPrivateKey('delegate-test')
const roguePrivate = loadTestPrivateKey('rogue-test')
const vendorPublicParams = exportPublicKeyParams(loadTestPublicKey('vendor-test'))
const roguePublicParams = exportPublicKeyParams(loadTestPublicKey('rogue-test'))

const NOW = Date.now()
const iso = (offsetMs: number): string => formatTimestamp(new Date(NOW + offsetMs))
const DAY = 24 * 60 * 60 * 1000

let workDir = ''
let projectDir = ''
let userDataDir = ''
let projectCode = ''
let deviceId = ''

const PROBE = `extends SceneTree
const License := preload("res://addons/aegis/aegis_license.gd")
const Device := preload("res://addons/aegis/aegis_device.gd")

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.has("--device-fallback"):
		print("FALLBACK1=" + Device._load_or_create_fallback())
		print("FALLBACK2=" + Device._load_or_create_fallback())
		quit(0)
		return
	print("PROJECT=" + License.project_code())
	print("DEVICE=" + Device.device_id())
	var r: Dictionary = License.evaluate(false)
	print("RESULT code=%s detail=%s valid=%s days=%d" % [r.code, r.detail, r.valid, r.days_left])
	quit(0)
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

function runProbeRaw(extraArgs: string[] = []): string {
  const args = ['--headless', '--path', projectDir, '-s', 'probe.gd']
  if (extraArgs.length > 0) {
    args.push('--', ...extraArgs)
  }
  const result = spawnSync(GODOT_BIN, args, {
    encoding: 'utf8',
    timeout: 60_000
  })
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

function runProbe(): { code: string; detail: string; valid: string; stdout: string } {
  const stdout = runProbeRaw()
  const match = stdout.match(/RESULT code=(\S+) detail=(\S*) valid=(\S+) days=(-?\d+)/)
  if (!match) {
    throw new Error(`Godot 探针没有输出结果：\n${stdout}`)
  }
  const code = match[1] ?? ''
  const detail = match[2] ?? ''
  const valid = match[3] ?? ''
  return { code, detail, valid, stdout }
}

function writeLicenseFiles(control: string | null, license: string | null): void {
  const controlPath = join(projectDir, 'control.cert')
  const licensePath = join(projectDir, 'license.dat')
  for (const [path, content] of [
    [controlPath, control],
    [licensePath, license]
  ] as const) {
    if (content === null) {
      if (existsSync(path)) rmSync(path)
    } else {
      writeFileSync(path, content, 'utf8')
    }
  }
}

function issuePair(overrides: {
  control?: Partial<Parameters<typeof makeVendorInput>[0]>
  machine?: Partial<Parameters<typeof makeMachineInput>[0]>
  machineKey?: typeof delegatePrivate
}): { control: string; license: string } {
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
  const license = issueMachineLicense(machineInput, overrides.machineKey ?? delegatePrivate)
  return { control: certificate.envelope, license: license.envelope }
}

function requireField(record: Record<string, string>, key: string): string {
  const value = record[key]
  if (value === undefined) {
    throw new Error(`信封缺少字段 ${key}`)
  }
  return value
}

/** 对任意 payload 字节签名，用于构造"签名有效但内容畸形"的用例 */
function signRawMachine(payloadText: string): string {
  return createEnvelope(Buffer.from(payloadText, 'utf8'), 'machine-license', delegatePrivate)
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

describe.skipIf(!hasGodot)('Node → Godot 真实授权联调', () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aegis-godot-it-'))
    projectDir = join(workDir, 'project')
    cpSync(godotSource, projectDir, {
      recursive: true,
      filter: (src) => {
        const base = src.split(/[\\/]/).pop() ?? ''
        if (base === '.godot' || base === 'build' || base === 'addons.zip') return false
        if (base === 'license.dat' || base === 'control.cert') return false
        return true
      }
    })

    // 临时工程改用独立项目名：user:// 目录隔离，不影响本机真实插件的时间记录
    const projectFile = join(projectDir, 'project.godot')
    const projectText = readFileSync(projectFile, 'utf8').replace(
      /config\/name="[^"]*"/,
      `config/name="aegis-it-${process.pid}"`
    )
    writeFileSync(projectFile, projectText, 'utf8')
    userDataDir = join(process.env.APPDATA ?? '', 'Godot', 'app_userdata', `aegis-it-${process.pid}`)
    writeFileSync(join(projectDir, 'probe.gd'), PROBE, 'utf8')
    writeFileSync(join(projectDir, 'addons', 'aegis', 'aegis_vendor_key.gd'), vendorKeyScript(vendorPublicParams), 'utf8')
    writeLicenseFiles(null, null)

    const probe = runProbe()
    const projectMatch = probe.stdout.match(/PROJECT=(\S+)/)
    const deviceMatch = probe.stdout.match(/DEVICE=(\S+)/)
    if (!projectMatch?.[1] || !deviceMatch?.[1]) {
      throw new Error(`无法读取项目 ID / 设备 ID：\n${probe.stdout}`)
    }
    projectCode = projectMatch[1]
    deviceId = deviceMatch[1]
  }, 120_000)

  afterAll(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true })
    }
    const appData = process.env.APPDATA
    if (appData) {
      rmSync(join(appData, 'Godot', 'app_userdata', `aegis-it-${process.pid}`), {
        recursive: true,
        force: true
      })
    }
  })

  it('合法证书链与有效子机授权：通过', () => {
    const pair = issuePair({})
    writeLicenseFiles(pair.control, pair.license)
    const result = runProbe()
    expect(result.code).toBe('0x000')
    expect(result.valid).toBe('true')
  })

  it('payload 被篡改：拒绝', () => {
    const pair = issuePair({})
    const envelope = JSON.parse(pair.license) as Record<string, string>
    const payload = Buffer.from(requireField(envelope, 'payload'), 'base64url')
    payload[10] = (payload[10] ?? 0) ^ 0x01
    envelope['payload'] = payload.toString('base64url')
    writeLicenseFiles(pair.control, JSON.stringify(envelope))
    expect(runProbe().code).toBe('0x022')
  })

  it('签名被篡改：拒绝', () => {
    const pair = issuePair({})
    const envelope = JSON.parse(pair.license) as Record<string, string>
    const signature = Buffer.from(requireField(envelope, 'signature'), 'base64url')
    signature[0] = (signature[0] ?? 0) ^ 0x01
    envelope['signature'] = signature.toString('base64url')
    writeLicenseFiles(pair.control, JSON.stringify(envelope))
    expect(runProbe().code).toBe('0x022')
  })

  it('错误厂商公钥：拒绝', () => {
    const pair = issuePair({})
    writeLicenseFiles(pair.control, pair.license)
    writeFileSync(
      join(projectDir, 'addons', 'aegis', 'aegis_vendor_key.gd'),
      vendorKeyScript(roguePublicParams),
      'utf8'
    )
    try {
      expect(runProbe().code).toBe('0x021')
    } finally {
      writeFileSync(
        join(projectDir, 'addons', 'aegis', 'aegis_vendor_key.gd'),
        vendorKeyScript(vendorPublicParams),
        'utf8'
      )
    }
  })

  it('错误委托私钥（证书链失败）：拒绝', () => {
    const pair = issuePair({ machineKey: roguePrivate })
    writeLicenseFiles(pair.control, pair.license)
    expect(runProbe().code).toBe('0x022')
  })

  it('项目 ID 不匹配：拒绝', () => {
    const pair = issuePair({ machine: { projectId: 'proj-other' } })
    writeLicenseFiles(pair.control, pair.license)
    expect(runProbe().code).toBe('0x033')
  })

  it('设备 ID 不匹配：拒绝', () => {
    const pair = issuePair({ machine: { deviceId: 'DEV-0000000000000000' } })
    writeLicenseFiles(pair.control, pair.license)
    expect(runProbe().code).toBe('0x035')
  })

  it('子机授权有效期超出中控证书：拒绝', () => {
    const pair = issuePair({ machine: { expiresAt: iso(400 * DAY) } })
    writeLicenseFiles(pair.control, pair.license)
    expect(runProbe().code).toBe('0x037')
  })

  it('中控证书过期：拒绝', () => {
    const pair = issuePair({ control: { issuedAt: iso(-400 * DAY), expiresAt: iso(-DAY) } })
    writeLicenseFiles(pair.control, pair.license)
    expect(runProbe().code).toBe('0x023')
  })

  it('子机授权过期：拒绝', () => {
    const pair = issuePair({
      machine: { issuedAt: iso(-30 * DAY), expiresAt: iso(-DAY) }
    })
    writeLicenseFiles(pair.control, pair.license)
    expect(runProbe().code).toBe('0x099')
  })

  it('子机授权状态为 revoked：拒绝', () => {
    const pair = issuePair({ machine: { status: 'revoked' } })
    writeLicenseFiles(pair.control, pair.license)
    expect(runProbe().code).toBe('0x036')
  })

  it('control_license_id 不匹配：拒绝', () => {
    const pair = issuePair({ machine: { controlLicenseId: 'VND-OTHER-0001' } })
    writeLicenseFiles(pair.control, pair.license)
    expect(runProbe().code).toBe('0x034')
  })

  it('重复 JSON 键（签名有效）：拒绝并给出 json_duplicate_key', () => {
    const pair = issuePair({})
    const payloadText = validMachinePayloadText().replace(
      `"device_id":"${deviceId}"`,
      `"device_id":"${deviceId}","device_id":"${deviceId}"`
    )
    writeLicenseFiles(pair.control, signRawMachine(payloadText))
    const result = runProbe()
    expect(result.code).toBe('0x022')
    expect(result.detail).toBe('json_duplicate_key')
  })

  it('非法 UTF-8 payload（签名有效）：拒绝并给出 json_invalid_utf8', () => {
    const pair = issuePair({})
    const payload = Buffer.from(validMachinePayloadText(), 'utf8')
    const marker = Buffer.from(`"device_id":"${deviceId}"`, 'utf8')
    const index = payload.indexOf(marker)
    expect(index).toBeGreaterThan(-1)
    const corrupted = Buffer.concat([payload.subarray(0, index), Buffer.from([0xff]), payload.subarray(index + 1)])
    writeLicenseFiles(pair.control, createEnvelope(corrupted, 'machine-license', delegatePrivate))
    const result = runProbe()
    expect(result.code).toBe('0x022')
    expect(result.detail).toBe('json_invalid_utf8')
  })

  it('非法数字（签名有效）：拒绝并给出 json_invalid_number', () => {
    const pair = issuePair({})
    const payloadText = validMachinePayloadText().replace('"schema_version":1', '"schema_version":1.0')
    writeLicenseFiles(pair.control, signRawMachine(payloadText))
    const result = runProbe()
    expect(result.code).toBe('0x022')
    expect(result.detail).toBe('json_invalid_number')
  })

  it('尾随数据（签名有效）：拒绝并给出 json_trailing_data', () => {
    const pair = issuePair({})
    writeLicenseFiles(pair.control, signRawMachine(`${validMachinePayloadText()} trailing`))
    const result = runProbe()
    expect(result.code).toBe('0x022')
    expect(result.detail).toBe('json_trailing_data')
  })

  it('非法转义（签名有效）：拒绝并给出 json_invalid_escape', () => {
    const pair = issuePair({})
    const payloadText = validMachinePayloadText().replace('"status":"active"', '"status":"act\\x41ive"')
    writeLicenseFiles(pair.control, signRawMachine(payloadText))
    const result = runProbe()
    expect(result.code).toBe('0x022')
    expect(result.detail).toBe('json_invalid_escape')
  })

  it('缺少 license.dat：拒绝', () => {
    const pair = issuePair({})
    writeLicenseFiles(pair.control, null)
    expect(runProbe().code).toBe('0x011')
  })

  it('缺少 control.cert：拒绝', () => {
    const pair = issuePair({})
    writeLicenseFiles(null, pair.license)
    expect(runProbe().code).toBe('0x013')
  })

  it('未配置厂商公钥：拒绝，不放行', () => {
    const pair = issuePair({})
    writeLicenseFiles(pair.control, pair.license)
    writeFileSync(join(projectDir, 'addons', 'aegis', 'aegis_vendor_key.gd'), vendorKeyScript(null), 'utf8')
    try {
      expect(runProbe().code).toBe('0x062')
    } finally {
      writeFileSync(
        join(projectDir, 'addons', 'aegis', 'aegis_vendor_key.gd'),
        vendorKeyScript(vendorPublicParams),
        'utf8'
      )
    }
  })

  it('设备 ID 在多次进程启动间保持稳定且符合标识符格式', () => {
    const pair = issuePair({})
    writeLicenseFiles(pair.control, pair.license)
    const first = runProbe()
    const second = runProbe()
    const firstId = first.stdout.match(/DEVICE=(\S+)/)?.[1]
    const secondId = second.stdout.match(/DEVICE=(\S+)/)?.[1]
    expect(firstId).toBe(deviceId)
    expect(secondId).toBe(deviceId)
    expect(deviceId).toMatch(/^DEV-[A-Za-z0-9._:-]{1,124}$/)
  })

  it('系统时钟回拨：拒绝并给出 0x052', () => {
    const pair = issuePair({})
    writeLicenseFiles(pair.control, pair.license)
    const secretText = readFileSync(join(godotSource, 'addons', 'aegis', 'aegis_secret.gd'), 'utf8')
    const secret = secretText.match(/SHARED_SECRET := "([^"]+)"/)?.[1]
    expect(secret).toBeTruthy()
    const future = Math.floor(Date.now() / 1000) + 86_400
    const checksum = createHash('sha256')
      .update(`${future}|${secret}|${projectCode}`)
      .digest('hex')
      .slice(0, 16)
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(join(userDataDir, 'aegis_time.dat'), `${future}:${checksum}`, 'utf8')
    try {
      expect(runProbe().code).toBe('0x052')
    } finally {
      rmSync(join(userDataDir, 'aegis_time.dat'), { force: true })
    }
  })

  it('设备 ID 回退文件缺失时生成，并在重启后保持稳定', () => {
    rmSync(join(userDataDir, 'aegis_device.id'), { force: true })
    const first = runProbeRaw(['--device-fallback'])
    const second = runProbeRaw(['--device-fallback'])
    const id1 = first.match(/FALLBACK1=(\S+)/)?.[1]
    const id2 = second.match(/FALLBACK1=(\S+)/)?.[1]
    expect(id1).toMatch(/^[a-f0-9]{32}$/)
    expect(id2).toBe(id1)
  })

  it('设备 ID 回退文件损坏时重新生成，不使用损坏值', () => {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(join(userDataDir, 'aegis_device.id'), 'bad', 'utf8')
    const result = runProbeRaw(['--device-fallback'])
    expect(result.match(/FALLBACK1=(\S+)/)?.[1]).toMatch(/^[a-f0-9]{32}$/)
  })

  it('超长授权文件：安全拒绝', () => {
    const pair = issuePair({})
    writeLicenseFiles(pair.control, 'x'.repeat(20_000))
    expect(runProbe().code).toBe('0x022')
  })
})
