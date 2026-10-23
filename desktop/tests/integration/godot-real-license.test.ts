import { createHash, createPublicKey } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadTestPrivateKey } from '../fixtures/test-keys'
import {
  DAY_MS,
  buildChain,
  buildContainer,
  copyProject,
  hasGodot,
  iso,
  runScript,
  signPayload,
  writeLegacyControl,
  writeLicense,
  writeVendorKey,
  type ChainOptions,
  type RunResult
} from './godot-plugin-helpers'

/**
 * Node → Godot 真实授权联调（容器格式 + 六步校验链）。
 *
 * 把 godot/ 工程复制到临时目录，写入测试厂商公钥与真实签名的容器 license.dat，
 * 用 Godot 4.6.3 headless 加载插件核心并读取它输出的错误码。
 *
 * 需要 GODOT_BIN 指向 Godot 4.6.3 console 版本；未设置时整组跳过。
 * 载荷按协议冻结稿手工签名，原因见 godot-plugin-helpers.ts 顶部说明。
 */

const vendorPrivate = loadTestPrivateKey('vendor-test')
const delegatePrivate = loadTestPrivateKey('delegate-test')
const roguePrivate = loadTestPrivateKey('rogue-test')
const vendorPublic = createPublicKey(vendorPrivate)

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
	var pc := License.project_code()
	print("PROJECT=" + pc)
	print("DEVICE=" + Device.device_id(pc))
	if args.has("--other-salt"):
		print("DEVICE_OTHER=" + Device.device_id(pc + "-other"))
	var r: Dictionary = License.evaluate(false)
	print(
		"RESULT code=%s detail=%s valid=%s days=%d id=%s expire=%s"
		% [r.code, r.detail, r.valid, r.days_left, r.license_id, r.expire]
	)
	print("RENEW_WINDOW=%d" % License.RENEW_WINDOW)
	print("DUE_29=" + str(License.is_renewal_due({ "valid": true, "days_left": 29 })))
	print("DUE_30=" + str(License.is_renewal_due({ "valid": true, "days_left": 30 })))
	print("DUE_INVALID=" + str(License.is_renewal_due({ "valid": false, "days_left": 3 })))
	print("DUE_SELF=" + str(License.is_renewal_due(r)))
	quit(0)
`

interface ProbeResult {
  code: string
  detail: string
  valid: string
  days: string
  id: string
  expire: string
  stdout: string
}

function writeProject(): void {
  writeFileSync(
    join(projectDir, 'project.godot'),
    [
      'config_version=5',
      '',
      '[application]',
      '',
      `config/name="aegis-it-${process.pid}"`,
      'config/features=PackedStringArray("4.6", "Forward Plus")',
      ''
    ].join('\n'),
    'utf8'
  )
}

function runProbe(extraArgs: string[] = []): RunResult {
  return runScript(projectDir, 'probe.gd', extraArgs)
}

function runEvaluated(): ProbeResult {
  const result = runProbe()
  const match = result.output.match(
    /RESULT code=(\S+) detail=(\S*) valid=(\S+) days=(-?\d+) id=(\S*) expire=(\S*)/
  )
  if (!match) throw new Error(`Godot 探针没有输出结果：\n${result.output}`)
  return {
    code: match[1] ?? '',
    detail: match[2] ?? '',
    valid: match[3] ?? '',
    days: match[4] ?? '',
    id: match[5] ?? '',
    expire: match[6] ?? '',
    stdout: result.output
  }
}

/** 用当前项目/设备签一条链，并把容器写进 license.dat */
function installChain(overrides: Partial<ChainOptions> = {}): ReturnType<typeof buildChain> {
  const chain = buildChain({
    projectId: projectCode,
    deviceId,
    vendorKey: vendorPrivate,
    delegateKey: delegatePrivate,
    ...overrides
  })
  writeLicense(projectDir, chain.container)
  writeLegacyControl(projectDir, null)
  return chain
}

describe.skipIf(!hasGodot)('Node → Godot 授权链（容器格式）', () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aegis-godot-it-'))
    projectDir = join(workDir, 'project')
    copyProject(projectDir)
    writeProject()
    writeFileSync(join(projectDir, 'probe.gd'), PROBE, 'utf8')
    writeVendorKey(projectDir, vendorPublic)
    writeLicense(projectDir, null)
    writeLegacyControl(projectDir, null)
    userDataDir = join(process.env.APPDATA ?? '', 'Godot', 'app_userdata', `aegis-it-${process.pid}`)

    const probe = runProbe()
    const projectMatch = probe.output.match(/PROJECT=(\S+)/)
    const deviceMatch = probe.output.match(/DEVICE=(\S+)/)
    if (!projectMatch?.[1] || !deviceMatch?.[1]) {
      throw new Error(`无法读取项目 ID / 设备 ID：\n${probe.output}`)
    }
    projectCode = projectMatch[1]
    deviceId = deviceMatch[1]
  }, 120_000)

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
    if (process.env.APPDATA) {
      rmSync(join(process.env.APPDATA, 'Godot', 'app_userdata', `aegis-it-${process.pid}`), {
        recursive: true,
        force: true
      })
    }
  })

  it('合法容器：通过，并回填授权 ID / 到期时间', () => {
    const chain = installChain()
    const result = runEvaluated()
    expect(result.code).toBe('0x000')
    expect(result.valid).toBe('true')
    expect(result.id).toBe(chain.licenseId)
    expect(Number(result.days)).toBeGreaterThan(80)
  })

  it('payload 被篡改：拒绝 0x022', () => {
    const chain = installChain()
    const envelope = JSON.parse(chain.license) as Record<string, string | number>
    const payload = Buffer.from(String(envelope['payload']), 'base64url')
    payload[10] = (payload[10] ?? 0) ^ 0x01
    envelope['payload'] = payload.toString('base64url')
    writeLicense(projectDir, buildContainer(JSON.stringify(envelope), chain.control))
    expect(runEvaluated().code).toBe('0x022')
  })

  it('签名被篡改：拒绝 0x022', () => {
    const chain = installChain()
    const envelope = JSON.parse(chain.license) as Record<string, string | number>
    const signature = Buffer.from(String(envelope['signature']), 'base64url')
    signature[0] = (signature[0] ?? 0) ^ 0x01
    envelope['signature'] = signature.toString('base64url')
    writeLicense(projectDir, buildContainer(JSON.stringify(envelope), chain.control))
    expect(runEvaluated().code).toBe('0x022')
  })

  it('厂商公钥不匹配：拒绝 0x021', () => {
    const chain = installChain()
    writeVendorKey(projectDir, createPublicKey(roguePrivate))
    try {
      expect(JSON.parse(chain.container).control).toBe(chain.control)
      expect(runEvaluated().code).toBe('0x021')
    } finally {
      writeVendorKey(projectDir, vendorPublic)
    }
  })

  it('委托私钥不匹配：拒绝 0x022', () => {
    installChain({ licenseSigner: roguePrivate })
    expect(runEvaluated().code).toBe('0x022')
  })

  it('子机授权项目与本机不一致：拒绝 0x033', () => {
    installChain({ machine: { projectId: 'proj-other' } })
    expect(runEvaluated().code).toBe('0x033')
  })

  it('本机项目不在中控证书范围：拒绝 0x033', () => {
    installChain({ control: { projectIds: ['proj-other'] } })
    expect(runEvaluated().code).toBe('0x033')
  })

  it('设备 ID 不匹配：拒绝 0x035', () => {
    installChain({ machine: { deviceId: 'DEV-0000000000000000' } })
    expect(runEvaluated().code).toBe('0x035')
  })

  it('子机授权到期晚于中控证书（e 步）：拒绝 0x037', () => {
    installChain({ machine: { expiresAt: iso(400 * DAY_MS) } })
    expect(runEvaluated().code).toBe('0x037')
  })

  it('中控证书已过期：拒绝 0x023', () => {
    installChain({ control: { issuedAt: iso(-400 * DAY_MS), expiresAt: iso(-DAY_MS) } })
    expect(runEvaluated().code).toBe('0x023')
  })

  it('子机授权已过期（f 步）：拒绝 0x099', () => {
    installChain({ machine: { issuedAt: iso(-30 * DAY_MS), expiresAt: iso(-DAY_MS) } })
    expect(runEvaluated().code).toBe('0x099')
  })

  it('子机授权状态为 revoked：拒绝 0x036', () => {
    installChain({ machine: { status: 'revoked' } })
    expect(runEvaluated().code).toBe('0x036')
  })

  it('control_license_id 不匹配：拒绝 0x034', () => {
    installChain({ machine: { controlLicenseId: 'VND-OTHER-0001' } })
    expect(runEvaluated().code).toBe('0x034')
  })

  it('重复 JSON 键（签名有效）：拒绝 0x022 json_duplicate_key', () => {
    installChain({
      mutateMachine: (text) =>
        text.replace(`"device_id":"${deviceId}"`, `"device_id":"${deviceId}","device_id":"${deviceId}"`)
    })
    const result = runEvaluated()
    expect(result.code).toBe('0x022')
    expect(result.detail).toBe('json_duplicate_key')
  })

  it('非法 UTF-8 payload（签名有效）：拒绝 0x022 json_invalid_utf8', () => {
    const chain = buildChain({
      projectId: projectCode,
      deviceId,
      vendorKey: vendorPrivate,
      delegateKey: delegatePrivate
    })
    const bytes = Buffer.from(chain.machinePayload, 'utf8')
    const marker = Buffer.from(`"device_id":"${deviceId}"`, 'utf8')
    const index = bytes.indexOf(marker)
    const corrupted = Buffer.concat([bytes.subarray(0, index), Buffer.from([0xff]), bytes.subarray(index + 1)])
    const license = signPayload(corrupted, 'machine-license', delegatePrivate)
    writeLicense(projectDir, buildContainer(license, chain.control))
    const result = runEvaluated()
    expect(result.code).toBe('0x022')
    expect(result.detail).toBe('json_invalid_utf8')
  })

  it('非法数字（签名有效）：拒绝 0x022 json_invalid_number', () => {
    installChain({
      mutateMachine: (text) => text.replace('"schema_version":1', '"schema_version":1.0')
    })
    const result = runEvaluated()
    expect(result.code).toBe('0x022')
    expect(result.detail).toBe('json_invalid_number')
  })

  it('尾随数据（签名有效）：拒绝 0x022 json_trailing_data', () => {
    installChain({ mutateMachine: (text) => `${text} trailing` })
    const result = runEvaluated()
    expect(result.code).toBe('0x022')
    expect(result.detail).toBe('json_trailing_data')
  })

  it('非法转义（签名有效）：拒绝 0x022 json_invalid_escape', () => {
    installChain({ mutateMachine: (text) => text.replace('"status":"active"', '"status":"act\\x41ive"') })
    const result = runEvaluated()
    expect(result.code).toBe('0x022')
    expect(result.detail).toBe('json_invalid_escape')
  })

  it('缺失 license.dat：拒绝 0x011', () => {
    writeLicense(projectDir, null)
    writeLegacyControl(projectDir, null)
    expect(runEvaluated().code).toBe('0x011')
  })

  it('空 license.dat：拒绝 0x012', () => {
    writeLicense(projectDir, '')
    expect(runEvaluated().code).toBe('0x012')
  })

  it('旧格式（裸信封）：拒绝 0x016', () => {
    const chain = installChain()
    writeLicense(projectDir, chain.license)
    expect(runEvaluated().code).toBe('0x016')
  })

  it('旧格式（只有 control.cert）：拒绝 0x016', () => {
    const chain = installChain()
    writeLicense(projectDir, null)
    writeLegacyControl(projectDir, chain.control)
    expect(runEvaluated().code).toBe('0x016')
  })

  it('容器多余键：拒绝 0x015 container_keys', () => {
    const chain = installChain()
    const container = JSON.parse(chain.container) as Record<string, unknown>
    container['extra'] = 1
    writeLicense(projectDir, JSON.stringify(container))
    const result = runEvaluated()
    expect(result.code).toBe('0x015')
    expect(result.detail).toBe('container_keys')
  })

  it('容器缺键：拒绝 0x015 container_keys', () => {
    const chain = installChain()
    writeLicense(projectDir, JSON.stringify({ v: 1, license: chain.license }))
    const result = runEvaluated()
    expect(result.code).toBe('0x015')
    expect(result.detail).toBe('container_keys')
  })

  it('容器版本不是 1：拒绝 0x015 container_version', () => {
    const chain = installChain()
    writeLicense(projectDir, JSON.stringify({ v: 2, license: chain.license, control: chain.control }))
    const result = runEvaluated()
    expect(result.code).toBe('0x015')
    expect(result.detail).toBe('container_version')
  })

  it('容器字段不是字符串：拒绝 0x015 container_fields', () => {
    const chain = installChain()
    writeLicense(projectDir, JSON.stringify({ v: 1, license: 1, control: chain.control }))
    const result = runEvaluated()
    expect(result.code).toBe('0x015')
    expect(result.detail).toBe('container_fields')
  })

  it('容器不是 JSON 对象：拒绝 0x015 container_not_object', () => {
    writeLicense(projectDir, '[1,2,3]')
    const result = runEvaluated()
    expect(result.code).toBe('0x015')
    expect(result.detail).toBe('container_not_object')
  })

  it('容器非法 JSON：拒绝 0x015 json_syntax', () => {
    writeLicense(projectDir, '{"v":1,"license":')
    const result = runEvaluated()
    expect(result.code).toBe('0x015')
    expect(result.detail).toBe('json_syntax')
  })

  it('容器超过 16384 字节：拒绝 0x015 container_too_large', () => {
    writeLicense(projectDir, JSON.stringify({ v: 1, license: 'x'.repeat(17_000), control: 'y' }))
    const result = runEvaluated()
    expect(result.code).toBe('0x015')
    expect(result.detail).toBe('container_too_large')
  })

  it('未配置厂商公钥：拒绝 0x062，不放行', () => {
    installChain()
    writeVendorKey(projectDir, null)
    try {
      expect(runEvaluated().code).toBe('0x062')
    } finally {
      writeVendorKey(projectDir, vendorPublic)
    }
  })

  it('设备 ID：符合标识符格式、跨进程稳定、换项目盐后不同', () => {
    const result = runProbe(['--other-salt'])
    const first = result.output.match(/DEVICE=(\S+)/)?.[1]
    const other = result.output.match(/DEVICE_OTHER=(\S+)/)?.[1]
    expect(first).toBe(deviceId)
    expect(deviceId).toMatch(/^DEV-[a-f0-9]{16}$/)
    expect(other).toMatch(/^DEV-[a-f0-9]{16}$/)
    expect(other).not.toBe(first)
  })

  it('设备 ID 不能缺少项目盐：空 project_id 返回空串（fail-closed）', () => {
    const saltProbe = `extends SceneTree
const Device := preload("res://addons/aegis/aegis_device.gd")

func _init() -> void:
	print("EMPTY_SALT=[" + Device.device_id("") + "]")
	quit(0)
`
    writeFileSync(join(projectDir, 'salt_probe.gd'), saltProbe, 'utf8')
    const result = runScript(projectDir, 'salt_probe.gd')
    expect(result.output).toContain('EMPTY_SALT=[]')
  })

  it('系统时钟回拨：拒绝 0x052', () => {
    installChain()
    const secretText = readFileSync(join(projectDir, 'addons', 'aegis', 'aegis_secret.gd'), 'utf8')
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
      expect(runEvaluated().code).toBe('0x052')
    } finally {
      rmSync(join(userDataDir, 'aegis_time.dat'), { force: true })
    }
  })

  it('续期窗口边界：RENEW_WINDOW=30，剩余 29 天进入临期、30 天不进入', () => {
    const result = runProbe()
    expect(result.output).toContain('RENEW_WINDOW=30')
    expect(result.output).toContain('DUE_29=true')
    expect(result.output).toContain('DUE_30=false')
    expect(result.output).toContain('DUE_INVALID=false')
  })

  it('续期窗口与真实授权联动：剩余 20 天为临期，剩余 90 天不临期', () => {
    installChain({ machine: { expiresAt: iso(20 * DAY_MS) } })
    expect(runProbe().output).toContain('DUE_SELF=true')
    installChain()
    expect(runProbe().output).toContain('DUE_SELF=false')
  })

  it('设备 ID 回退文件：首次生成 32 位 hex，重启后保持稳定', () => {
    rmSync(join(userDataDir, 'aegis_device.id'), { force: true })
    const first = runProbe(['--device-fallback']).output.match(/FALLBACK1=(\S+)/)?.[1]
    const second = runProbe(['--device-fallback']).output.match(/FALLBACK1=(\S+)/)?.[1]
    expect(first).toMatch(/^[a-f0-9]{32}$/)
    expect(second).toBe(first)
  })

  it('设备 ID 回退文件损坏：重新生成，不使用损坏值', () => {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(join(userDataDir, 'aegis_device.id'), 'bad', 'utf8')
    const value = runProbe(['--device-fallback']).output.match(/FALLBACK1=(\S+)/)?.[1]
    expect(value).toMatch(/^[a-f0-9]{32}$/)
    if (existsSync(join(userDataDir, 'aegis_device.id'))) {
      expect(readFileSync(join(userDataDir, 'aegis_device.id'), 'utf8').trim()).toBe(value)
    }
  })
})
