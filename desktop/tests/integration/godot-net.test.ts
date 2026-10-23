import { createPublicKey } from 'node:crypto'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
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
  runScript,
  runScriptAsync,
  startTcpHub,
  writeLegacyControl,
  writeLicense,
  writeVendorKey,
  type Chain,
  type FakeHub,
  type ReplyOptions
} from './godot-plugin-helpers'

/**
 * 局域网授权拉取（aegis_net.gd）。
 *
 * 用进程内的假中控（TCP 47821 / UDP 47820）代替真实中控主机；
 * Godot 侧用探针脚本直接驱动 aegis_net 的非阻塞轮询。
 */

const vendorPrivate = loadTestPrivateKey('vendor-test')
const delegatePrivate = loadTestPrivateKey('delegate-test')
const vendorPublic = createPublicKey(vendorPrivate)

const TCP_PORT = 47821
const UDP_PORT = 47820
const DISCOVERY_TCP_PORT = 47831

let workDir = ''
let projectDir = ''
let projectCode = ''
let deviceId = ''
let localChain: Chain
let newerChain: Chain
let olderChain: Chain

const NET_PROBE = `extends SceneTree
const License := preload("res://addons/aegis/aegis_license.gd")
const Net := preload("res://addons/aegis/aegis_net.gd")

var _net: Node
var _start := 0.0
var _done := false


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var current := {}
	if not args.has("--no-current"):
		current = License.evaluate(false)
		print("CURRENT code=%s id=%s expire=%s" % [current.code, current.license_id, current.expire])
	_net = Net.new()
	root.add_child(_net)
	_net.license_updated.connect(_on_updated)
	_net.pull_finished.connect(_on_finished)
	_start = float(Time.get_ticks_msec()) / 1000.0
	_net.request_pull(current)


func _on_updated(result: Dictionary) -> void:
	print("UPDATED id=%s expire=%s" % [result.license_id, result.expire])


func _on_finished(info: Dictionary) -> void:
	print(
		"PULL ok=%s status=%s code=%s total=%.2f"
		% [info.ok, info.status, info.code, float(Time.get_ticks_msec()) / 1000.0 - _start]
	)
	_done = true
	quit(0)


func _process(_delta: float) -> bool:
	if not _done and float(Time.get_ticks_msec()) / 1000.0 - _start > 10.0:
		print("PROBE_TIMEOUT")
		quit(0)
	return false
`

const DISCOVER_PROBE = `extends SceneTree
const License := preload("res://addons/aegis/aegis_license.gd")
const Device := preload("res://addons/aegis/aegis_device.gd")

func _init() -> void:
	var pc := License.project_code()
	print("PROJECT=" + pc)
	print("DEVICE=" + Device.device_id(pc))
	quit(0)
`

async function withTcpHub(
  reply: (request: string) => ReplyOptions,
  run: (hub: FakeHub) => Promise<void>
): Promise<void> {
  const hub = await startTcpHub(TCP_PORT, reply)
  try {
    await run(hub)
  } finally {
    await hub.close()
  }
}

interface ProbeOutcome {
  ok: boolean
  status: string
  code: string
  total: number
  updated: boolean
  output: string
}

async function runNetProbe(extraArgs: string[] = []): Promise<ProbeOutcome> {
  const result = await runScriptAsync(projectDir, 'net_probe.gd', extraArgs)
  const match = result.output.match(/PULL ok=(\w+) status=(\S*) code=(\S*) total=([\d.]+)/)
  if (!match) throw new Error(`拉取探针没有输出结果：\n${result.output}`)
  return {
    ok: match[1] === 'true',
    status: match[2] ?? '',
    code: match[3] ?? '',
    total: Number(match[4]),
    updated: result.output.includes('UPDATED'),
    output: result.output
  }
}

function chainWithExpiry(days: number, licenseId: string): Chain {
  return buildChain({
    projectId: projectCode,
    deviceId,
    vendorKey: vendorPrivate,
    delegateKey: delegatePrivate,
    machine: { licenseId, expiresAt: iso(days * DAY_MS) }
  })
}

function readLicenseFile(): string {
  return readFileSync(join(projectDir, 'license.dat'), 'utf8')
}

describe.skipIf(!hasGodot)('局域网授权拉取（TCP 47821 / UDP 47820）', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'aegis-godot-net-'))
    projectDir = join(workDir, 'project')
    copyProject(projectDir)
    writeFileSync(
      join(projectDir, 'project.godot'),
      [
        'config_version=5',
        '',
        '[application]',
        '',
        `config/name="aegis-net-${process.pid}"`,
        'run/main_scene="res://main.tscn"',
        'config/features=PackedStringArray("4.6", "Forward Plus")',
        ''
      ].join('\n'),
      'utf8'
    )
    writeFileSync(join(projectDir, 'net_probe.gd'), NET_PROBE, 'utf8')
    writeFileSync(join(projectDir, 'discover.gd'), DISCOVER_PROBE, 'utf8')
    writeVendorKey(projectDir, vendorPublic)
    writeLicense(projectDir, null)
    writeLegacyControl(projectDir, null)

    const discover = runScript(projectDir, 'discover.gd')
    const projectMatch = discover.output.match(/PROJECT=(\S+)/)
    const deviceMatch = discover.output.match(/DEVICE=(\S+)/)
    if (!projectMatch?.[1] || !deviceMatch?.[1]) {
      throw new Error(`无法读取项目 ID / 设备 ID：\n${discover.output}`)
    }
    projectCode = projectMatch[1]
    deviceId = deviceMatch[1]

    localChain = buildChain({
      projectId: projectCode,
      deviceId,
      vendorKey: vendorPrivate,
      delegateKey: delegatePrivate,
      machine: { licenseId: 'MCH-LOCAL-0001', expiresAt: iso(90 * DAY_MS) }
    })
    newerChain = chainWithExpiry(200, 'MCH-NEWER-0002')
    olderChain = chainWithExpiry(30, 'MCH-OLDER-0003')
    writeLicense(projectDir, localChain.container)
  }, 120_000)

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
    if (process.env.APPDATA) {
      rmSync(join(process.env.APPDATA, 'Godot', 'app_userdata', `aegis-net-${process.pid}`), {
        recursive: true,
        force: true
      })
    }
  })

  it('TCP 127.0.0.1:47821 下发更新的授权：接受并原子替换 license.dat', async () => {
    await withTcpHub(
      () => ({ status: 'issued', license: newerChain.container }),
      async (hub) => {
        const before = readLicenseFile()
        const outcome = await runNetProbe()
        expect(outcome.ok).toBe(true)
        expect(outcome.status).toBe('issued')
        expect(outcome.updated).toBe(true)
        expect(outcome.output).toContain('UPDATED id=MCH-NEWER-0002')
        expect(readLicenseFile()).not.toBe(before)
        expect(readLicenseFile()).toBe(newerChain.container)
        expect(hub.requests).toHaveLength(1)

        // 请求行必须严格匹配协议字段
        const request = JSON.parse(hub.requests[0] as string) as Record<string, unknown>
        expect(Object.keys(request).sort()).toEqual(
          ['current_license_id', 'device_id', 'last_expires_at', 'nonce', 'project_id', 'v'].sort()
        )
        expect(request['v']).toBe(1)
        expect(request['device_id']).toBe(deviceId)
        expect(request['project_id']).toBe(projectCode)
        expect(request['current_license_id']).toBe('MCH-LOCAL-0001')
        const localExpire = (JSON.parse(localChain.machinePayload) as { expires_at: string }).expires_at
        expect(request['last_expires_at']).toBe(localExpire)
        expect(String(request['nonce'])).toMatch(/^[a-f0-9]{16}$/)
      }
    )
  })

  it('status=unchanged：不改本地授权', async () => {
    writeLicense(projectDir, localChain.container)
    await withTcpHub(
      () => ({ status: 'unchanged', license: '' }),
      async () => {
        const outcome = await runNetProbe()
        expect(outcome.ok).toBe(true)
        expect(outcome.status).toBe('unchanged')
        expect(outcome.updated).toBe(false)
        expect(readLicenseFile()).toBe(localChain.container)
      }
    )
  })

  it('status=denied：不改本地授权', async () => {
    writeLicense(projectDir, localChain.container)
    await withTcpHub(
      () => ({ status: 'denied', license: '', reason: 'not_registered' }),
      async () => {
        const outcome = await runNetProbe()
        expect(outcome.ok).toBe(true)
        expect(outcome.status).toBe('denied')
        expect(outcome.updated).toBe(false)
        expect(readLicenseFile()).toBe(localChain.container)
      }
    )
  })

  it('nonce 不回显：拒绝且不改本地授权', async () => {
    writeLicense(projectDir, localChain.container)
    await withTcpHub(
      () => ({ status: 'issued', license: newerChain.container, nonce: 'deadbeefdeadbeef' }),
      async () => {
        const outcome = await runNetProbe()
        expect(outcome.ok).toBe(false)
        expect(outcome.code).toBe('reply_nonce')
        expect(readLicenseFile()).toBe(localChain.container)
      }
    )
  })

  it('下发的授权不比当前更晚：拒绝（防降级）', async () => {
    writeLicense(projectDir, localChain.container)
    await withTcpHub(
      () => ({ status: 'issued', license: olderChain.container }),
      async () => {
        const outcome = await runNetProbe()
        expect(outcome.ok).toBe(false)
        expect(outcome.code).toBe('not_newer')
        expect(readLicenseFile()).toBe(localChain.container)
      }
    )
  })

  it('下发的容器签名无效：拒绝且不改本地授权', async () => {
    writeLicense(projectDir, localChain.container)
    const broken = JSON.stringify({ v: 1, license: '{"aegis":"license-envelope"}', control: newerChain.control })
    await withTcpHub(
      () => ({ status: 'issued', license: broken }),
      async () => {
        const outcome = await runNetProbe()
        expect(outcome.ok).toBe(false)
        expect(outcome.code).toMatch(/^license_invalid/)
        expect(readLicenseFile()).toBe(localChain.container)
      }
    )
  })

  it('中控不可达：静默失败，总耗时不超过 2 秒 + 1 秒余量', async () => {
    writeLicense(projectDir, localChain.container)
    const outcome = await runNetProbe()
    expect(outcome.ok).toBe(false)
    expect(outcome.updated).toBe(false)
    expect(outcome.total).toBeLessThan(3)
    expect(readLicenseFile()).toBe(localChain.container)
  })

  it('UDP 47820 发现后改用下发的端口拉取成功', async () => {
    writeLicense(projectDir, localChain.container)
    const hub = await startTcpHub(DISCOVERY_TCP_PORT, () => ({ status: 'issued', license: newerChain.container }))
    const udp: UdpSocket = createSocket('udp4')
    let discoveries = 0
    udp.on('message', (message, remote) => {
      if (!message.toString('utf8').startsWith('AEGIS-DISCOVER/1 ')) return
      discoveries += 1
      const reply = `AEGIS-HERE/1 127.0.0.1 ${DISCOVERY_TCP_PORT}`
      udp.send(reply, remote.port, remote.address)
    })
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject)
      udp.bind(UDP_PORT, () => resolve())
    })
    try {
      const outcome = await runNetProbe()
      expect(discoveries).toBeGreaterThan(0)
      expect(outcome.ok).toBe(true)
      expect(outcome.status).toBe('issued')
      expect(outcome.updated).toBe(true)
      expect(hub.requests).toHaveLength(1)
      expect(readLicenseFile()).toBe(newerChain.container)
    } finally {
      await new Promise<void>((resolve) => udp.close(() => resolve()))
      await hub.close()
    }
  })
})
