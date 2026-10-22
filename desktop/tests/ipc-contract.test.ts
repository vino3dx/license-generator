import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, WORKSPACE_ENTRIES } from '../src/shared/ipc-contract'

describe('IPC 契约', () => {
  it('通道名唯一且带命名空间前缀', () => {
    const channels = Object.values(IPC_CHANNELS)
    expect(new Set(channels).size).toBe(channels.length)
    for (const channel of channels) {
      expect(channel).toMatch(/^[a-z]+:[a-z-]+$/)
    }
  })
})

describe('工作区入口', () => {
  it('四个入口 key 唯一', () => {
    const keys = WORKSPACE_ENTRIES.map((entry) => entry.key)
    expect(keys).toHaveLength(4)
    expect(new Set(keys).size).toBe(4)
  })

  it('每个入口都有标题与说明', () => {
    for (const entry of WORKSPACE_ENTRIES) {
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.summary.length).toBeGreaterThan(0)
    }
  })
})
