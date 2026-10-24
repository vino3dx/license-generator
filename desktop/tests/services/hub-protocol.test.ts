import { describe, expect, it } from 'vitest'
import {
  buildDiscoverResponse,
  buildPullResponse,
  isLoopbackAddress,
  parseDiscoverPacket,
  parsePullRequest
} from '@core/services/hub-protocol'

function requestOf(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      device_id: 'DEV-1',
      project_id: 'proj-a',
      current_license_id: '',
      last_expires_at: null,
      nonce: '0123456789abcdef',
      ...overrides
    }),
    'utf8'
  )
}

describe('拉取请求解析（与 aegis_net.gd 对齐）', () => {
  it('接受插件实际发送的请求结构', () => {
    const parsed = parsePullRequest(requestOf())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.deviceId).toBe('DEV-1')
      expect(parsed.value.projectId).toBe('proj-a')
      expect(parsed.value.currentLicenseId).toBe('')
      expect(parsed.value.lastExpiresAt).toBeNull()
      expect(parsed.value.nonce).toBe('0123456789abcdef')
    }
  })

  it('拒绝多余键、缺失键、版本不符与空 nonce', () => {
    const extra = Buffer.from(
      JSON.stringify({
        v: 1,
        device_id: 'DEV-1',
        project_id: 'proj-a',
        current_license_id: '',
        last_expires_at: null,
        nonce: 'n',
        extra: true
      })
    )
    expect(parsePullRequest(extra)).toEqual({ ok: false, reason: 'request_keys' })

    const missing = Buffer.from(JSON.stringify({ v: 1, device_id: 'DEV-1' }))
    expect(parsePullRequest(missing)).toEqual({ ok: false, reason: 'request_keys' })

    expect(parsePullRequest(requestOf({ v: 2 }))).toEqual({ ok: false, reason: 'request_version' })
    expect(parsePullRequest(requestOf({ nonce: '' }))).toEqual({ ok: false, reason: 'request_nonce' })
    expect(parsePullRequest(requestOf({ device_id: '' }))).toEqual({ ok: false, reason: 'request_device_id' })
    expect(parsePullRequest(requestOf({ project_id: 'bad id' }))).toEqual({
      ok: false,
      reason: 'request_project_id'
    })
    expect(parsePullRequest(requestOf({ last_expires_at: 123 }))).toEqual({
      ok: false,
      reason: 'request_last_expires_at'
    })
  })

  it('拒绝重复键、畸形 JSON、空请求与超长请求', () => {
    const duplicate = Buffer.from(
      '{"v":1,"device_id":"DEV-1","device_id":"DEV-2","project_id":"proj-a","current_license_id":"","last_expires_at":null,"nonce":"n"}'
    )
    expect(parsePullRequest(duplicate)).toEqual({ ok: false, reason: 'request_malformed' })
    expect(parsePullRequest(Buffer.from('{oops'))).toEqual({ ok: false, reason: 'request_malformed' })
    expect(parsePullRequest(Buffer.alloc(0))).toEqual({ ok: false, reason: 'request_empty' })
    expect(parsePullRequest(Buffer.alloc(5000, 0x41))).toEqual({ ok: false, reason: 'request_too_large' })
  })

  it('拒绝非法 UTF-8 字节', () => {
    const invalid = Buffer.from([0x7b, 0xff, 0xfe, 0x7d])
    expect(parsePullRequest(invalid)).toEqual({ ok: false, reason: 'request_invalid_utf8' })
  })
})

describe('响应构造', () => {
  it('恰好包含 v/status/license/reason/nonce 五个键，并回显 nonce', () => {
    const text = buildPullResponse({
      status: 'issued',
      license: '{"v":1,"license":"L","control":"C"}',
      reason: '',
      nonce: 'nonce-1'
    })
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['license', 'nonce', 'reason', 'status', 'v'])
    expect(parsed['v']).toBe(1)
    expect(parsed['status']).toBe('issued')
    expect(parsed['nonce']).toBe('nonce-1')
    expect(parsed['license']).toBe('{"v":1,"license":"L","control":"C"}')
    expect(parsed['reason']).toBe('')
  })

  it('denied / unchanged 不携带授权内容，但给出原因', () => {
    const denied = JSON.parse(
      buildPullResponse({ status: 'denied', license: 'should-be-dropped', reason: 'device_not_registered', nonce: 'n' })
    ) as Record<string, unknown>
    expect(denied['license']).toBe('')
    expect(denied['reason']).toBe('device_not_registered')

    const unchanged = JSON.parse(
      buildPullResponse({ status: 'unchanged', license: 'x', reason: 'already_current', nonce: 'n' })
    ) as Record<string, unknown>
    expect(unchanged['license']).toBe('')
    expect(unchanged['status']).toBe('unchanged')
  })

  it('授权超出响应上限时降级为 denied，而不是截断容器', () => {
    const text = buildPullResponse({
      status: 'issued',
      license: 'A'.repeat(20000),
      reason: '',
      nonce: 'n'
    })
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(parsed['status']).toBe('denied')
    expect(parsed['reason']).toBe('license_too_large')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(16384)
  })
})

describe('UDP 发现协议', () => {
  it('解析插件的发现包', () => {
    const parsed = parseDiscoverPacket(Buffer.from('AEGIS-DISCOVER/1 DEV-1 proj-a', 'utf8'))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.deviceId).toBe('DEV-1')
      expect(parsed.value.projectId).toBe('proj-a')
    }
  })

  it('拒绝错误前缀、字段数量不符与超长包', () => {
    expect(parseDiscoverPacket(Buffer.from('AEGIS-HERE/1 1.2.3.4 47821'))).toEqual({
      ok: false,
      reason: 'discover_prefix'
    })
    expect(parseDiscoverPacket(Buffer.from('AEGIS-DISCOVER/1 DEV-1'))).toEqual({
      ok: false,
      reason: 'discover_shape'
    })
    expect(parseDiscoverPacket(Buffer.alloc(300, 0x41))).toEqual({ ok: false, reason: 'discover_size' })
  })

  it('构造应答并识别回环地址', () => {
    expect(buildDiscoverResponse('192.168.1.5', 47821).toString('utf8')).toBe('AEGIS-HERE/1 192.168.1.5 47821')
    expect(buildDiscoverResponse('127.0.0.1', 47821).toString('utf8')).toBe('AEGIS-HERE/1 127.0.0.1 47821')
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
  })
})

describe('协议版本兼容判定', () => {
  it('仓库内插件只接受 v1，中控签发 v3，默认判定为不兼容', async () => {
    const { isClientSchemaSupported, clientSchemaReason } = await import('@core/services/delivery')
    expect(isClientSchemaSupported()).toBe(false)
    expect(clientSchemaReason()).toContain('schema_version=3')
    expect(clientSchemaReason()).toContain('schema_version=1')
  })
})
