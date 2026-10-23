import { spawnSync } from 'node:child_process'
import { createPublicKey } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadTestPrivateKey } from '../fixtures/test-keys'
import {
  GODOT_BIN,
  PYTHON,
  addonsZip,
  buildChain,
  copyProject,
  godotSource,
  hasGodot,
  listSourceFiles,
  readZipEntries,
  runGame,
  sha256,
  writeLegacyControl,
  writeLicense,
  writeVendorKey,
  type ChainOptions
} from './godot-plugin-helpers'

/**
 * Aegis Godot 插件：失败拦截 / 时间戳严格性 / 分发包 / 干净工程安装。
 *
 * 与 godot-real-license.test.ts 互补：
 * - 那边验证「授权链判定是否正确」；
 * - 这边验证「判定失败后进程是否真的被拦住」以及「分发包能否直接安装运行」。
 *
 * 需要 GODOT_BIN 指向 Godot 4.6.3 console 版本；未设置时整组跳过。
 */

const vendorPrivate = loadTestPrivateKey('vendor-test')
const delegatePrivate = loadTestPrivateKey('delegate-test')
const vendorPublic = createPublicKey(vendorPrivate)

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
	var pc := License.project_code()
	print("PROJECT=" + pc)
	print("DEVICE=" + Device.device_id(pc))
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

function writeProject(target: string, withProbe: boolean): void {
  const lines = [
    'config_version=5',
    '',
    '[application]',
    '',
    `config/name="${projectName}"`,
    withProbe ? 'run/main_scene="res://main_probe.tscn"' : 'run/main_scene="res://main.tscn"',
    'config/features=PackedStringArray("4.6", "Forward Plus")',
    '',
    '[autoload]',
    '',
    'Aegis="*res://addons/aegis/aegis.gd"',
    ''
  ]
  writeFileSync(join(target, 'project.godot'), lines.join('\n'), 'utf8')
  if (withProbe) {
    writeFileSync(join(target, 'main_probe.gd'), MAIN_PROBE, 'utf8')
    writeFileSync(join(target, 'main_probe.tscn'), MAIN_SCENE, 'utf8')
  }
}

/** 以当前临时工程的项目 ID / 设备 ID 签一条容器并落盘 */
function installChain(overrides: Partial<ChainOptions> = {}) {
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

describe.skipIf(!hasGodot)('Aegis Godot 插件：失败拦截与分发包', () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aegis-godot-deny-'))
    projectDir = join(workDir, 'project')
    cleanDir = join(workDir, 'clean')
    copyProject(projectDir)
    projectName = `aegis-deny-${process.pid}`
    writeProject(projectDir, true)
    writeVendorKey(projectDir, vendorPublic)
    writeFileSync(join(projectDir, 'discover.gd'), DISCOVER_PROBE, 'utf8')
    writeLicense(projectDir, null)
    writeLegacyControl(projectDir, null)

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

  describe('授权失败拦截（headless，静默）', () => {
    it('无授权文件：静默退出码 1，主场景不进入 _process，is_licensed() 为 false', () => {
      writeLicense(projectDir, null)
      writeLegacyControl(projectDir, null)
      const result = runGame(projectDir)
      expect(result.output).not.toContain('[Aegis]')
      expect(result.output).not.toContain('授权')
      expect(result.output).toContain('IS_LICENSED=false')
      expect(result.output).not.toContain('MAIN_PROCESS=1')
      expect(result.status).toBe(1)
    })

    it('无授权文件：不挂起，10 秒内退出', () => {
      writeLicense(projectDir, null)
      writeLegacyControl(projectDir, null)
      const result = runGame(projectDir, 20_000)
      expect(result.status).toBe(1)
      expect(result.elapsedMs).toBeLessThan(10_000)
    })

    it('重复触发授权失败：不重复处理，进程只退出一次（退出码 1）', () => {
      writeLicense(projectDir, null)
      writeLegacyControl(projectDir, null)
      const result = runGame(projectDir)
      expect(result.status).toBe(1)
      expect(result.output).toContain('IS_LICENSED=false')
    })

    it('旧版裸信封：静默拒绝且不挂起', () => {
      const chain = installChain()
      writeLicense(projectDir, chain.license)
      const result = runGame(projectDir)
      expect(result.output).not.toContain('[Aegis]')
      expect(result.status).toBe(1)
    })

    it('合法容器：主场景正常执行并自行退出 0', () => {
      installChain()
      const result = runGame(projectDir)
      expect(result.output).toContain('IS_LICENSED=true')
      expect(result.output).toContain('MAIN_PROCESS=3')
      expect(result.status).toBe(0)
    })
  })

  describe('时间戳严格性（签名有效但时间非法，静默拒绝）', () => {
    it('子机授权 issued_at 非法日历值：静默退出码 1', () => {
      installChain({
        mutateMachine: (text) => text.replace(/"issued_at":"[^"]*"/, '"issued_at":"2027-13-45T00:00:00Z"')
      })
      const result = runGame(projectDir)
      expect(result.output).not.toContain('[Aegis]')
      expect(result.status).toBe(1)
    })

    it('中控证书 issued_at 非法日历值：静默退出码 1', () => {
      installChain({
        mutateVendor: (text) => text.replace(/"issued_at":"[^"]*"/, '"issued_at":"2027-13-45T00:00:00Z"')
      })
      const result = runGame(projectDir)
      expect(result.output).not.toContain('[Aegis]')
      expect(result.status).toBe(1)
    })
  })

  describe('分发包 addons.zip', () => {
    beforeAll(() => {
      // 分发包是构建产物（releases/，不入库），断言前先按脚本生成一次
      const build = spawnSync(PYTHON, [join(godotSource, 'package_addons.py')], { encoding: 'utf8' })
      expect(build.status).toBe(0)
    })

    it('条目与源码目录逐文件一致（含 .uid），不含私钥/缓存/测试产物', () => {
      const entries = readZipEntries(addonsZip)
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
      const first = spawnSync(PYTHON, [join(godotSource, 'package_addons.py')], { encoding: 'utf8' })
      expect(first.status).toBe(0)
      const hash1 = sha256(readFileSync(addonsZip))
      const second = spawnSync(PYTHON, [join(godotSource, 'package_addons.py')], { encoding: 'utf8' })
      expect(second.status).toBe(0)
      expect(sha256(readFileSync(addonsZip))).toBe(hash1)
    })
  })

  describe('干净工程安装', () => {
    it('解压后可被编辑器识别（无脚本/插件加载错误）', () => {
      mkdirSync(cleanDir, { recursive: true })
      for (const [name, content] of readZipEntries(addonsZip)) {
        if (name.endsWith('/')) continue
        const target = join(cleanDir, name)
        mkdirSync(join(target, '..'), { recursive: true })
        writeFileSync(target, content)
      }
      writeProject(cleanDir, false)
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

    it('安装后空公钥仍 fail-closed：静默退出码 1', () => {
      writeProject(cleanDir, true)
      writeLicense(cleanDir, null)
      writeLegacyControl(cleanDir, null)
      const result = runGame(cleanDir)
      expect(result.output).not.toContain('[Aegis]')
      expect(result.status).toBe(1)
    })

    it('安装后配置真实测试公钥与容器授权：合法链放行', () => {
      writeProject(cleanDir, true)
      writeVendorKey(cleanDir, vendorPublic)
      const chain = buildChain({
        projectId: projectCode,
        deviceId,
        vendorKey: vendorPrivate,
        delegateKey: delegatePrivate
      })
      writeLicense(cleanDir, chain.container)
      writeLegacyControl(cleanDir, null)
      const result = runGame(cleanDir)
      expect(result.output).toContain('IS_LICENSED=true')
      expect(result.status).toBe(0)
    })
  })
})

