import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeUtf8 } from '@core/license/encoding'
import { isLicenseError } from '@core/license/errors'
import { parseStrictJson } from '@core/license/strict-json'

/**
 * 与 GDScript 共用的严格 JSON 向量。
 * 同一份 tests/vectors/strict-json-cases.json 也会被 tests/integration/verifier-godot/strict_json_runner.gd 读取，
 * 两端必须得出相同的 ok/失败结论。
 */
interface JsonCase {
  readonly id: string
  readonly input: string
  readonly expect: string
  readonly expect_ok: boolean
}

interface Utf8Case {
  readonly id: string
  readonly hex: string
  readonly valid: boolean
}

interface Fixture {
  readonly version: number
  readonly json_cases: readonly JsonCase[]
  readonly utf8_cases: readonly Utf8Case[]
}

const fixturePath = fileURLToPath(new URL('../../../tests/vectors/strict-json-cases.json', import.meta.url))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture

function tryParse(text: string): { ok: boolean; value?: unknown } {
  try {
    return { ok: true, value: parseStrictJson(text, 'payload_malformed') }
  } catch (error) {
    if (isLicenseError(error) && error.code === 'payload_malformed') {
      return { ok: false }
    }
    throw error
  }
}

describe('严格 JSON 共享向量（Node 侧）', () => {
  it('向量文件包含预期数量的用例', () => {
    expect(fixture.version).toBe(1)
    expect(fixture.json_cases.length).toBeGreaterThanOrEqual(50)
    expect(fixture.utf8_cases.length).toBeGreaterThanOrEqual(10)
  })

  for (const entry of fixture.json_cases) {
    it(`${entry.id} → ${entry.expect}`, () => {
      const result = tryParse(entry.input)
      expect(result.ok).toBe(entry.expect_ok)
      if (result.ok) {
        // 合法输入必须与标准解析器得到相同的值（数字在协议范围内，无精度问题）
        expect(result.value).toEqual(JSON.parse(entry.input))
      }
    })
  }

  for (const entry of fixture.utf8_cases) {
    it(`${entry.id} → ${entry.valid ? '合法' : '非法'} UTF-8`, () => {
      const bytes = Buffer.from(entry.hex, 'hex')
      let decoded = true
      try {
        decodeUtf8(bytes, 'payload_malformed')
      } catch {
        decoded = false
      }
      expect(decoded).toBe(entry.valid)
    })
  }
})
