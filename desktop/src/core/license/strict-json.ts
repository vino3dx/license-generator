import { LicenseError, type LicenseErrorCode } from './errors'

/**
 * 严格 JSON 解析器。
 *
 * 与 JSON.parse 的差异（都是本协议需要的）：
 * - 拒绝重复键（避免「同一个字段两个值」的歧义）；
 * - 数字只允许非负整数，且必须在安全整数范围内；
 * - 拒绝字符串中的裸控制字符与未知转义；
 * - 限制嵌套深度与字符串长度；
 * - 拒绝尾部多余内容（空白除外）。
 */
const MAX_DEPTH = 8
/** 信封里承载 Base64URL 的字段本身就超过 1 KiB，这里只做粗上限，真正的体积限制在 envelope.ts */
const MAX_STRING_LENGTH = 16 * 1024

export function parseStrictJson(text: string, code: LicenseErrorCode): unknown {
  return new StrictJsonParser(text, code).parseDocument()
}

class StrictJsonParser {
  private index = 0

  constructor(
    private readonly text: string,
    private readonly code: LicenseErrorCode
  ) {}

  parseDocument(): unknown {
    this.skipWhitespace()
    const value = this.parseValue(0)
    this.skipWhitespace()
    if (this.index !== this.text.length) {
      throw this.fail('JSON 尾部存在多余内容')
    }
    return value
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_DEPTH) {
      throw this.fail('JSON 嵌套层级过深')
    }
    const char = this.text[this.index]
    switch (char) {
      case '{':
        return this.parseObject(depth)
      case '[':
        return this.parseArray(depth)
      case '"':
        return this.parseString()
      case 't':
        this.expectLiteral('true')
        return true
      case 'f':
        this.expectLiteral('false')
        return false
      case 'n':
        this.expectLiteral('null')
        return null
      default:
        if (char !== undefined && char >= '0' && char <= '9') {
          return this.parseInteger()
        }
        throw this.fail('JSON 值不合法')
    }
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.index += 1
    const result: Record<string, unknown> = {}
    this.skipWhitespace()
    if (this.text[this.index] === '}') {
      this.index += 1
      return result
    }
    for (;;) {
      this.skipWhitespace()
      if (this.text[this.index] !== '"') {
        throw this.fail('JSON 对象的键必须是字符串')
      }
      const key = this.parseString()
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        throw this.fail(`JSON 对象存在重复键: ${key}`)
      }
      this.skipWhitespace()
      if (this.text[this.index] !== ':') {
        throw this.fail('JSON 对象缺少冒号')
      }
      this.index += 1
      this.skipWhitespace()
      result[key] = this.parseValue(depth + 1)
      this.skipWhitespace()
      const next = this.text[this.index]
      if (next === ',') {
        this.index += 1
        continue
      }
      if (next === '}') {
        this.index += 1
        return result
      }
      throw this.fail('JSON 对象缺少逗号或右花括号')
    }
  }

  private parseArray(depth: number): unknown[] {
    this.index += 1
    const result: unknown[] = []
    this.skipWhitespace()
    if (this.text[this.index] === ']') {
      this.index += 1
      return result
    }
    for (;;) {
      this.skipWhitespace()
      result.push(this.parseValue(depth + 1))
      this.skipWhitespace()
      const next = this.text[this.index]
      if (next === ',') {
        this.index += 1
        continue
      }
      if (next === ']') {
        this.index += 1
        return result
      }
      throw this.fail('JSON 数组缺少逗号或右方括号')
    }
  }

  private parseString(): string {
    this.index += 1
    let result = ''
    for (;;) {
      const char = this.text[this.index]
      if (char === undefined) {
        throw this.fail('JSON 字符串未闭合')
      }
      if (char === '"') {
        this.index += 1
        return result
      }
      if (char === '\\') {
        result += this.parseEscape()
      } else {
        const code = char.charCodeAt(0)
        if (code < 0x20) {
          throw this.fail('JSON 字符串包含裸控制字符')
        }
        result += char
        this.index += 1
      }
      if (result.length > MAX_STRING_LENGTH) {
        throw this.fail('JSON 字符串过长')
      }
    }
  }

  private parseEscape(): string {
    const next = this.text[this.index + 1]
    this.index += 2
    switch (next) {
      case '"':
        return '"'
      case '\\':
        return '\\'
      case '/':
        return '/'
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case 'u': {
        const hex = this.text.slice(this.index, this.index + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw this.fail('JSON Unicode 转义不合法')
        }
        this.index += 4
        const unit = Number.parseInt(hex, 16)
        // 代理项必须成对出现（RFC 8259 §8.2）；孤立代理在 UTF-8 中无法表示，
        // 若放行会导致 Node 与 GDScript 解析出不同字符串。
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (this.text[this.index] !== '\\' || this.text[this.index + 1] !== 'u') {
            throw this.fail('JSON 高代理项缺少配对的低代理项')
          }
          const lowHex = this.text.slice(this.index + 2, this.index + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) {
            throw this.fail('JSON 低代理项转义不合法')
          }
          const low = Number.parseInt(lowHex, 16)
          if (low < 0xdc00 || low > 0xdfff) {
            throw this.fail('JSON 代理项配对不合法')
          }
          this.index += 6
          return String.fromCharCode(unit, low)
        }
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          throw this.fail('JSON 存在孤立低代理项')
        }
        return String.fromCharCode(unit)
      }
      default:
        throw this.fail('JSON 含未知转义')
    }
  }

  private parseInteger(): number {
    const start = this.index
    while (this.index < this.text.length) {
      const char = this.text[this.index]
      if (char === undefined || char < '0' || char > '9') {
        break
      }
      this.index += 1
    }
    const raw = this.text.slice(start, this.index)
    if (raw.length > 1 && raw.startsWith('0')) {
      throw this.fail('JSON 整数含前导零')
    }
    const value = Number(raw)
    if (!Number.isSafeInteger(value)) {
      throw this.fail('JSON 整数超出安全范围')
    }
    return value
  }

  private expectLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.index)) {
      throw this.fail('JSON 字面量不合法')
    }
    this.index += literal.length
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const char = this.text[this.index]
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        this.index += 1
      } else {
        return
      }
    }
  }

  private fail(message: string): LicenseError {
    return new LicenseError(this.code, `${message}（位置 ${this.index}）`)
  }
}
