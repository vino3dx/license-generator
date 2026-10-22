import { decodeUtf8 } from './encoding'
import { LicenseError } from './errors'
import { parseStrictJson } from './strict-json'

/**
 * license.dat 容器（共同约定 v3.1 §3）。
 *
 * 文件内容是严格 JSON：
 *   {"v":1,"license":"<machine-license 信封文本>","control":"<control.cert 信封文本>"}
 *
 * - 信封与 payload 一个字节都不改，容器只是外层包装；
 * - 键集合严格：多余或缺失键都拒绝（container_malformed）；
 * - 整个文件 ≤ 16384 字节；
 * - 旧格式（裸信封、单独 control.cert）不再被接受。
 */

export const LICENSE_CONTAINER_MAX_BYTES = 16384
export const LICENSE_CONTAINER_VERSION = 1

const CONTAINER_KEYS = ['v', 'license', 'control'] as const

export interface LicenseContainer {
  readonly license: string
  readonly control: string
}

export function buildLicenseContainer(licenseEnvelope: string, controlEnvelope: string): string {
  // JSON.stringify 对字符串字段的转义是 RFC 8259 合法输出，且键顺序固定
  const text = JSON.stringify({ v: LICENSE_CONTAINER_VERSION, license: licenseEnvelope, control: controlEnvelope })
  if (Buffer.byteLength(text, 'utf8') > LICENSE_CONTAINER_MAX_BYTES) {
    throw new LicenseError('container_malformed', '授权容器超出 16384 字节上限')
  }
  return text
}

export function parseLicenseContainer(bytes: Uint8Array): LicenseContainer {
  if (bytes.length === 0 || bytes.length > LICENSE_CONTAINER_MAX_BYTES) {
    throw new LicenseError('container_malformed', '授权容器大小不合法')
  }
  const text = decodeUtf8(bytes, 'container_malformed')
  const parsed = parseStrictJson(text, 'container_malformed')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LicenseError('container_malformed', '授权容器必须是 JSON 对象')
  }
  const keys = Object.keys(parsed).sort()
  if (keys.length !== CONTAINER_KEYS.length || !CONTAINER_KEYS.every((key, index) => keys[index] === key)) {
    throw new LicenseError('container_malformed', '授权容器必须恰好包含 v / license / control')
  }
  const record = parsed as Record<string, unknown>
  if (record['v'] !== LICENSE_CONTAINER_VERSION) {
    throw new LicenseError('container_malformed', `授权容器版本必须是 ${LICENSE_CONTAINER_VERSION}`)
  }
  const license = record['license']
  const control = record['control']
  if (typeof license !== 'string' || typeof control !== 'string' || license.length === 0 || control.length === 0) {
    throw new LicenseError('container_malformed', '授权容器的 license / control 必须是非空字符串')
  }
  return { license, control }
}
