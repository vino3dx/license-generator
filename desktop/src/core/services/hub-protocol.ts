import { parseStrictJson } from '@core/license/strict-json'
import {
  HUB_DISCOVER_MAX_BYTES,
  HUB_DISCOVER_PREFIX,
  HUB_HERE_PREFIX,
  HUB_REQUEST_MAX_BYTES,
  HUB_RESPONSE_MAX_BYTES
} from '@shared/license/hub-contract'

/**
 * 局域网拉取协议编解码（纯函数，无 socket、无数据库）。
 *
 * 与 `godot/addons/aegis/aegis_net.gd` 逐字段对齐：
 * - 请求键集合固定 6 个，严格 JSON（重复键/非法 UTF-8 直接拒绝）；
 * - 响应键集合固定 5 个（v/status/license/reason/nonce），nonce 必须原样回显；
 * - 请求 ≤4096B，响应 ≤16384B（与授权容器上限一致）。
 */

export const PULL_REQUEST_KEYS = [
  'v',
  'device_id',
  'project_id',
  'current_license_id',
  'last_expires_at',
  'nonce'
] as const

export const PULL_RESPONSE_KEYS = ['v', 'status', 'license', 'reason', 'nonce'] as const

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/
const TRANSPORT_VERSION = 1

export interface PullRequestInput {
  readonly deviceId: string
  readonly projectId: string
  /** 设备自报的当前授权 ID；没有本地授权时为空串 */
  readonly currentLicenseId: string
  /** 设备自报的当前到期时间；没有则为 null */
  readonly lastExpiresAt: string | null
  readonly nonce: string
}

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

export function parsePullRequest(bytes: Uint8Array): ParseResult<PullRequestInput> {
  if (bytes.length === 0) {
    return { ok: false, reason: 'request_empty' }
  }
  if (bytes.length > HUB_REQUEST_MAX_BYTES) {
    return { ok: false, reason: 'request_too_large' }
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, reason: 'request_invalid_utf8' }
  }

  let parsed: unknown
  try {
    parsed = parseStrictJson(text, 'payload_invalid')
  } catch {
    return { ok: false, reason: 'request_malformed' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'request_malformed' }
  }
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== PULL_REQUEST_KEYS.length) {
    return { ok: false, reason: 'request_keys' }
  }
  for (const key of PULL_REQUEST_KEYS) {
    if (!keys.includes(key)) {
      return { ok: false, reason: 'request_keys' }
    }
  }
  if (record['v'] !== TRANSPORT_VERSION) {
    return { ok: false, reason: 'request_version' }
  }
  const deviceId = record['device_id']
  const projectId = record['project_id']
  if (typeof deviceId !== 'string' || !IDENTIFIER.test(deviceId)) {
    return { ok: false, reason: 'request_device_id' }
  }
  if (typeof projectId !== 'string' || !IDENTIFIER.test(projectId)) {
    return { ok: false, reason: 'request_project_id' }
  }
  const currentLicenseId = record['current_license_id']
  if (typeof currentLicenseId !== 'string' || currentLicenseId.length > 128) {
    return { ok: false, reason: 'request_current_license_id' }
  }
  const lastExpiresAt = record['last_expires_at']
  if (lastExpiresAt !== null && (typeof lastExpiresAt !== 'string' || lastExpiresAt.length === 0)) {
    return { ok: false, reason: 'request_last_expires_at' }
  }
  const nonce = record['nonce']
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 64) {
    return { ok: false, reason: 'request_nonce' }
  }

  return {
    ok: true,
    value: { deviceId, projectId, currentLicenseId, lastExpiresAt, nonce }
  }
}

export type PullStatus = 'issued' | 'unchanged' | 'denied'

/** 构造响应行；license 过大时自动降级为 denied（不能截断授权容器） */
export function buildPullResponse(input: {
  readonly status: PullStatus
  readonly license: string
  readonly reason: string
  readonly nonce: string
}): string {
  const payload = {
    v: TRANSPORT_VERSION,
    status: input.status,
    license: input.status === 'issued' ? input.license : '',
    reason: input.status === 'issued' ? '' : input.reason,
    nonce: input.nonce
  }
  let text = JSON.stringify(payload)
  if (Buffer.byteLength(text, 'utf8') > HUB_RESPONSE_MAX_BYTES) {
    text = JSON.stringify({ v: TRANSPORT_VERSION, status: 'denied', license: '', reason: 'license_too_large', nonce: input.nonce })
  }
  return text
}

/** UDP 发现包解析：`AEGIS-DISCOVER/1 <device_id> <project_id>` */
export function parseDiscoverPacket(bytes: Buffer): ParseResult<{ deviceId: string; projectId: string }> {
  if (bytes.length === 0 || bytes.length > HUB_DISCOVER_MAX_BYTES) {
    return { ok: false, reason: 'discover_size' }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, reason: 'discover_invalid_utf8' }
  }
  if (!text.startsWith(HUB_DISCOVER_PREFIX)) {
    return { ok: false, reason: 'discover_prefix' }
  }
  const parts = text.split(' ')
  if (parts.length !== 3) {
    return { ok: false, reason: 'discover_shape' }
  }
  const deviceId = (parts[1] ?? '').trim()
  const projectId = (parts[2] ?? '').trim()
  if (!IDENTIFIER.test(deviceId) || !IDENTIFIER.test(projectId)) {
    return { ok: false, reason: 'discover_identifier' }
  }
  return { ok: true, value: { deviceId, projectId } }
}

/** UDP 发现应答：`AEGIS-HERE/1 <host> <port>` */
export function buildDiscoverResponse(host: string, port: number): Buffer {
  return Buffer.from(`${HUB_HERE_PREFIX}${host} ${port}`, 'utf8')
}

export function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address.startsWith('127.')
}
