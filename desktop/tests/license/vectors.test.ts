import { createHash, createPublicKey, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEnvelope, openEnvelope } from '@core/license/envelope'
import { isLicenseError } from '@core/license/errors'
import { parseMachinePayload, parseVendorPayload } from '@core/license/payloads'
import { importPublicKeyParams } from '@core/license/rsa-keys'
import { buildVectors, type VectorCase, type VectorsFile } from '../fixtures/vectors-builder'
import { loadTestPrivateKey } from '../fixtures/test-keys'

// 跨语言协议向量放在仓库级 tests/vectors/，Node 与 Godot 共用同一份
const VECTOR_FILE = join(process.cwd(), '..', 'tests', 'vectors', 'vectors.json')
const keys: Record<VectorCase['key'], KeyObject> = {
  vendor: createPublicKey(loadTestPrivateKey('vendor-test')),
  delegate: createPublicKey(loadTestPrivateKey('delegate-test')),
  rogue: createPublicKey(loadTestPrivateKey('rogue-test'))
}

function runCase(testCase: VectorCase): string {
  try {
    const opened = openEnvelope(testCase.envelope, testCase.license_type, keys[testCase.key])
    if (testCase.license_type === 'vendor-control') {
      parseVendorPayload(opened.payloadBytes)
    } else {
      parseMachinePayload(opened.payloadBytes)
    }
    return 'ok'
  } catch (error) {
    if (isLicenseError(error)) {
      return error.code
    }
    return 'unexpected_exception'
  }
}

function vectorFile(): VectorsFile {
  return JSON.parse(readFileSync(VECTOR_FILE, 'utf8')) as VectorsFile
}

function walkFiles(directory: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) {
      result.push(...walkFiles(full))
    } else {
      result.push(full)
    }
  }
  return result
}

describe('测试向量文件', () => {
  it('与当前代码生成结果一致（AEGIS_WRITE_VECTORS=1 时重写）', () => {
    const built = buildVectors()
    if (process.env['AEGIS_WRITE_VECTORS'] === '1') {
      writeFileSync(VECTOR_FILE, `${JSON.stringify(built, null, 2)}\n`, 'utf8')
    }
    expect(existsSync(VECTOR_FILE)).toBe(true)
    expect(vectorFile()).toEqual(built)
  })

  it('记录的是原始 payload 字节与签名，且可复现', () => {
    const file = vectorFile()
    const vendorPayload = Buffer.from(file.vendor_certificate.payload_b64url, 'base64url')
    const vendorSignature = Buffer.from(file.vendor_certificate.signature_b64url, 'base64url')
    const resigned = JSON.parse(
      createEnvelope(vendorPayload, 'vendor-control', loadTestPrivateKey('vendor-test'))
    ) as Record<string, string>
    expect(Buffer.from(resigned['signature'] ?? '', 'base64url').equals(vendorSignature)).toBe(true)
    expect(file.vendor_certificate.payload_sha256_hex).toBe(
      createHash('sha256').update(vendorPayload).digest('hex')
    )
  })

  it('公钥参数可用于重建公钥（协议格式自洽）', () => {
    const file = vectorFile()
    const rebuilt = importPublicKeyParams(file.keys.delegate.public)
    expect(rebuilt.asymmetricKeyType).toBe('rsa')
    expect(rebuilt.asymmetricKeyDetails?.modulusLength).toBe(2048)
  })

  it('每个用例的实际结果与期望一致', () => {
    const results = vectorFile().cases.map((testCase) => ({
      id: testCase.id,
      actual: runCase(testCase),
      expect: testCase.expect
    }))
    const mismatched = results.filter((item) => item.actual !== item.expect)
    expect(mismatched).toEqual([])
    expect(results.length).toBeGreaterThanOrEqual(15)
    expect(results.filter((item) => item.actual === 'ok').length).toBe(2)
  })
})

describe('密钥与产物卫生', () => {
  it('src/ 与 out/ 中不存在任何私钥材料', () => {
    const targets = ['src', 'out'].map((dir) => join(process.cwd(), dir)).filter((dir) => existsSync(dir))
    const offenders: string[] = []
    for (const target of targets) {
      for (const file of walkFiles(target)) {
        if (!/\.(ts|js|cjs|mjs|json|html|css|vue|txt|map)$/.test(file)) {
          continue
        }
        const text = readFileSync(file, 'utf8')
        if (text.includes('PRIVATE KEY')) {
          offenders.push(file)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('打包配置只包含构建产物，不包含测试与密钥', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    expect(config).toContain('out/**')
    expect(config).not.toContain('tests/')
    expect(config).not.toContain('fixtures')
  })

  it('测试密钥目录带 TEST ONLY 标注', () => {
    const readme = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'keys', 'README.md'), 'utf8')
    expect(readme).toContain('TEST ONLY')
  })
})
