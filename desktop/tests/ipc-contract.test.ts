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
  // 入口数量由界面实际决定（v3 界面收敛为「授权管理 / 审计记录」两个），这里只约束唯一性与形态
  it('入口 key 唯一且为合法标识', () => {
    const keys = WORKSPACE_ENTRIES.map((entry) => entry.key)
    expect(keys.length).toBeGreaterThanOrEqual(2)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z-]*$/)
    }
  })

  it('每个入口都有标题与说明', () => {
    for (const entry of WORKSPACE_ENTRIES) {
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.summary.length).toBeGreaterThan(0)
    }
  })
})
