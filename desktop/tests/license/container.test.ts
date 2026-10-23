import { describe, expect, it } from 'vitest'
import {
  LICENSE_CONTAINER_MAX_BYTES,
  LICENSE_CONTAINER_VERSION,
  buildLicenseContainer,
  parseLicenseContainer
} from '@core/license/container'
import { isLicenseError } from '@core/license/errors'

const LICENSE = '{"aegis":"license-envelope","schema_version":3}'
const CONTROL = '{"aegis":"license-envelope","schema_version":3,"license_type":"vendor-control"}'

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function expectContainerError(action: () => unknown): void {
  try {
    action()
  } catch (error) {
    expect(isLicenseError(error)).toBe(true)
    expect((error as { code: string }).code).toBe('container_malformed')
    return
  }
  throw new Error('期望抛出 container_malformed，但调用成功')
}

describe('license.dat 容器（约定 v3.1 §2）', () => {
  it('构建后是严格 JSON，键集合为 v / license / control', () => {
    const text = buildLicenseContainer(LICENSE, CONTROL)
    const record = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(record)).toEqual(['v', 'license', 'control'])
    expect(record['v']).toBe(LICENSE_CONTAINER_VERSION)
    expect(record['license']).toBe(LICENSE)
    expect(record['control']).toBe(CONTROL)
  })

  it('构建与解析可往返，信封文本一字不改', () => {
    const text = buildLicenseContainer(LICENSE, CONTROL)
    const parsed = parseLicenseContainer(bytesOf(text))
    expect(parsed.license).toBe(LICENSE)
    expect(parsed.control).toBe(CONTROL)
  })

  it('键顺序不同但集合相同的容器仍可解析', () => {
    const text = JSON.stringify({ control: CONTROL, v: 1, license: LICENSE })
    const parsed = parseLicenseContainer(bytesOf(text))
    expect(parsed.license).toBe(LICENSE)
    expect(parsed.control).toBe(CONTROL)
  })

  it('多余或缺失键一律拒绝', () => {
    expectContainerError(() =>
      parseLicenseContainer(bytesOf(JSON.stringify({ v: 1, license: LICENSE, control: CONTROL, extra: 1 })))
    )
    const { control: _dropped, ...missing } = { v: 1, license: LICENSE, control: CONTROL }
    expectContainerError(() => parseLicenseContainer(bytesOf(JSON.stringify(missing))))
  })

  it('版本必须为 1', () => {
    expectContainerError(() =>
      parseLicenseContainer(bytesOf(JSON.stringify({ v: 2, license: LICENSE, control: CONTROL })))
    )
    expectContainerError(() =>
      parseLicenseContainer(bytesOf(JSON.stringify({ v: '1', license: LICENSE, control: CONTROL })))
    )
  })

  it('license / control 必须是非空字符串', () => {
    expectContainerError(() => parseLicenseContainer(bytesOf(JSON.stringify({ v: 1, license: '', control: CONTROL }))))
    expectContainerError(() => parseLicenseContainer(bytesOf(JSON.stringify({ v: 1, license: LICENSE, control: 5 }))))
  })

  it('顶层必须是 JSON 对象', () => {
    expectContainerError(() => parseLicenseContainer(bytesOf('[]')))
    expectContainerError(() => parseLicenseContainer(bytesOf('"x"')))
  })

  it('旧格式（裸信封）不再被接受', () => {
    expectContainerError(() => parseLicenseContainer(bytesOf(LICENSE)))
    expectContainerError(() => parseLicenseContainer(bytesOf(CONTROL)))
  })

  it('非法 JSON、非法 UTF-8 与空文件拒绝', () => {
    expectContainerError(() => parseLicenseContainer(bytesOf('{')))
    expectContainerError(() => parseLicenseContainer(new Uint8Array([0xff, 0xfe])))
    expectContainerError(() => parseLicenseContainer(new Uint8Array()))
  })

  it('整体大小上限 16384 字节，构建时超限报错', () => {
    const huge = 'x'.repeat(LICENSE_CONTAINER_MAX_BYTES)
    expectContainerError(() => buildLicenseContainer(huge, CONTROL))
    expectContainerError(() => parseLicenseContainer(bytesOf('x'.repeat(LICENSE_CONTAINER_MAX_BYTES + 1))))
  })
})
