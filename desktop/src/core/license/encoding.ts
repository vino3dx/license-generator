import { LicenseError, type LicenseErrorCode } from './errors'

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * 严格 Base64URL 解码：拒绝填充符、非法字符、长度 %4==1 和非规范尾部位。
 */
export function decodeBase64Url(text: string, code: LicenseErrorCode): Buffer {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) {
    throw new LicenseError(code, 'Base64URL 内容不合法')
  }
  const buffer = Buffer.from(text, 'base64url')
  if (encodeBase64Url(buffer) !== text) {
    throw new LicenseError(code, 'Base64URL 非规范编码')
  }
  return buffer
}

export function encodeUtf8(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

export function decodeUtf8(bytes: Uint8Array, code: LicenseErrorCode): string {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new LicenseError(code, '字节串不是合法 UTF-8')
  }
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    return false
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed)
}

export function parseTimestamp(value: string): number {
  if (!isTimestamp(value)) {
    throw new LicenseError('payload_invalid', `时间格式不合法: ${String(value)}`)
  }
  return Date.parse(value)
}

/** 以秒精度输出，保证跨语言可复现 */
export function formatTimestamp(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 19)}Z`
}

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

export function isPositiveIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

/** 大写十六进制，仅用于日志与测试向量展示 */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}
