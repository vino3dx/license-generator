import { createPublicKey } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadTestPrivateKey } from '../fixtures/test-keys'
import {
  DAY_MS,
  buildChain,
  copyProject,
  hasGodot,
  iso,
  runGameAsync,
  runScript,
  writeLegacyControl,
  writeLicense,
  writeVendorKey,
  type Chain
} from './godot-plugin-helpers'

/**
 * GUI（非 headless）模式下的静默拦截：2026-10-23 起插件不再有申请码门控界面，
 * 授权无效（含过期）一律静默退出码 1——无弹窗、无界面、无任何输出。
 *
 * 这些用例必须用「有显示」的方式运行（不加 --headless），
 * 否则走的还是 headless 分支，验证不到 GUI 行为。
 * 有效授权的用例靠 8 秒超时终止进程：进程一直活着正是「未拦截」的证据。
 */

const vendorPrivate = loadTestPrivateKey('vendor-test')
const delegatePrivate = loadTestPrivateKey('delegate-test')
const vendorPublic = createPublicKey(vendorPrivate)

let workDir = ''
let projectDir = ''
let projectName = ''
let projectCode = ''
let deviceId = ''
let validChain: Chain
let expiredChain: Chain

function writeProjectFile(withAutoload: boolean): void {
  const lines = [
    'config_version=5',
    '',
    '[application]',
    '',
    `config/name="${projectName}"`,
    'run/main_scene="res://main.tscn"',
    'config/features=PackedStringArray("4.6", "Forward Plus")',
    ''
  ]
  if (withAutoload) {
    lines.push('[autoload]', '', 'Aegis="*res://addons/aegis/aegis.gd"', '')
  }
  writeFileSync(join(projectDir, 'project.godot'), lines.join('\n'), 'utf8')
}

describe.skipIf(!hasGodot)('GUI 模式静默拦截（无任何提示界面与输出）', () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aegis-godot-silent-'))
    projectDir = join(workDir, 'project')
    projectName = `aegis-silent-${process.pid}`
    copyProject(projectDir)
    writeVendorKey(projectDir, vendorPublic)
    writeLicense(projectDir, null)
    writeLegacyControl(projectDir, null)

    // 取项目 ID / 设备 ID 时不能带 autoload，否则 Aegis 会先拦截并退出
    writeProjectFile(false)
    writeFileSync(
      join(projectDir, 'discover.gd'),
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
    const discover = runScript(projectDir, 'discover.gd')
    const projectMatch = discover.output.match(/PROJECT=(\S+)/)
    const deviceMatch = discover.output.match(/DEVICE=(\S+)/)
    if (!projectMatch?.[1] || !deviceMatch?.[1]) {
      throw new Error(`无法读取项目 ID / 设备 ID：\n${discover.output}`)
    }
    projectCode = projectMatch[1]
    deviceId = deviceMatch[1]

    const base = {
      projectId: projectCode,
      deviceId,
      vendorKey: vendorPrivate,
      delegateKey: delegatePrivate
    }
    validChain = buildChain({ ...base, machine: { licenseId: 'MCH-SILENT-OK1', expiresAt: iso(90 * DAY_MS) } })
    expiredChain = buildChain({
      ...base,
      machine: { licenseId: 'MCH-SILENT-EX1', issuedAt: iso(-100 * DAY_MS), expiresAt: iso(-10 * DAY_MS) }
    })
    writeProjectFile(true)
  }, 180_000)

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
    if (process.env.APPDATA) {
      rmSync(join(process.env.APPDATA, 'Godot', 'app_userdata', projectName), { recursive: true, force: true })
    }
  })

  it('无授权：静默退出码 1，5 秒内退出，无任何插件输出', async () => {
    writeLicense(projectDir, null)
    const run = await runGameAsync(projectDir, [], 30_000)
    expect(run.status).toBe(1)
    expect(run.elapsedMs).toBeLessThan(5_000)
    expect(run.output).not.toContain('[Aegis]')
    expect(run.output).not.toContain('授权')
  })

  it('授权过期：同样静默退出码 1', async () => {
    writeLicense(projectDir, expiredChain.container)
    const run = await runGameAsync(projectDir, [], 30_000)
    expect(run.status).toBe(1)
    expect(run.elapsedMs).toBeLessThan(5_000)
    expect(run.output).not.toContain('[Aegis]')
  })

  it('有效授权：不被拦截，进程持续运行（超时终止即证据），无插件输出', async () => {
    writeLicense(projectDir, validChain.container)
    const run = await runGameAsync(projectDir, [], 8_000)
    // 被超时杀掉 = 进程一直在跑，没有被授权逻辑退出
    expect(run.status).not.toBe(1)
    expect(run.output).not.toContain('[Aegis]')
    expect(run.output).not.toContain('授权')
  })
})
