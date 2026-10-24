import { afterEach, describe, expect, it } from 'vitest'
import {
  appendDeviceRequest,
  createDatabase,
  findActiveDeliveryOrder,
  findDeliveryOrder,
  incrementDeliveryAttempts,
  insertDeliveryOrder,
  listDeliveryOrders,
  listDeviceMeta,
  listDeviceRequests,
  updateDeliveryOrderState,
  upsertDeviceMeta,
  type SqliteDatabase
} from '@core/db'
import { ServiceError } from '@core/services'
import {
  assertDeliveryTransition,
  canTransitionDelivery,
  deliveryIdempotencyKey,
  isDeliveryActiveState,
  isDeliveryTerminalState
} from '@core/services/delivery-state'
import {
  DELIVERY_ACTIVE_STATES,
  DELIVERY_STATES,
  DELIVERY_TERMINAL_STATES,
  type DeliveryOrderDto,
  type DeliveryState
} from '@shared/license/delivery-contract'

const opened: SqliteDatabase[] = []

function freshDb(): SqliteDatabase {
  const { database } = createDatabase(':memory:')
  database.exec(
    "INSERT INTO projects (project_id, name, status, created_at) VALUES ('proj-a', 'A', 'active', '2026-10-24T00:00:00Z')"
  )
  database.exec(
    "INSERT INTO devices (project_id, device_id, registered_at) VALUES ('proj-a', 'dev-1', '2026-10-24T00:00:00Z')"
  )
  database.exec(
    "INSERT INTO devices (project_id, device_id, registered_at) VALUES ('proj-a', 'dev-2', '2026-10-24T00:00:00Z')"
  )
  opened.push(database)
  return database
}

afterEach(() => {
  for (const database of opened.splice(0)) {
    try {
      database.close()
    } catch {
      // 已关闭
    }
  }
})

function orderOf(overrides: Partial<DeliveryOrderDto> = {}): DeliveryOrderDto {
  return {
    orderId: 'ord-1',
    kind: 'issue',
    state: 'generated',
    licenseId: 'MCH-1',
    projectId: 'proj-a',
    deviceId: 'dev-1',
    controlLicenseId: 'VND-1',
    expiresAt: '2027-01-01T00:00:00Z',
    attempts: 0,
    lastError: null,
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
    sentAt: null,
    confirmedAt: null,
    requestedBy: 'tester',
    ...overrides
  }
}

describe('派发状态机', () => {
  it('只允许合法的状态流转，本地写入成功不能跳到 confirmed', () => {
    expect(canTransitionDelivery('generated', 'queued')).toBe(true)
    expect(canTransitionDelivery('queued', 'sent')).toBe(true)
    expect(canTransitionDelivery('sent', 'confirmed')).toBe(true)
    expect(canTransitionDelivery('failed', 'queued')).toBe(true)
    expect(canTransitionDelivery('timeout', 'queued')).toBe(true)

    // 直接由本地生成跳到"已确认"必须被拒绝
    expect(canTransitionDelivery('generated', 'confirmed')).toBe(false)
    expect(canTransitionDelivery('queued', 'confirmed')).toBe(false)
    // 已发送不能退回队列，只能由明确结果结束
    expect(canTransitionDelivery('sent', 'queued')).toBe(false)
    // confirmed / denied / unsupported 是终态
    for (const terminal of DELIVERY_TERMINAL_STATES) {
      for (const next of DELIVERY_STATES) {
        expect(canTransitionDelivery(terminal, next)).toBe(false)
      }
    }
  })

  it('非法流转抛出 conflict 业务错误', () => {
    expect(() => assertDeliveryTransition('generated', 'confirmed')).toThrow(ServiceError)
    try {
      assertDeliveryTransition('generated', 'confirmed')
    } catch (error) {
      expect((error as ServiceError).code).toBe('conflict')
    }
    expect(() => assertDeliveryTransition('sent', 'confirmed')).not.toThrow()
  })

  it('活跃与终态集合与共享契约一致', () => {
    for (const state of DELIVERY_STATES) {
      expect(isDeliveryActiveState(state)).toBe(DELIVERY_ACTIVE_STATES.includes(state))
      expect(isDeliveryTerminalState(state)).toBe(DELIVERY_TERMINAL_STATES.includes(state))
    }
    // CONFIRMED 同时是终态与"占用幂等键"的状态：已确认的订单不允许重复签发同一期限授权
    expect(isDeliveryActiveState('confirmed')).toBe(true)
    expect(isDeliveryTerminalState('confirmed')).toBe(true)
    // denied / unsupported 是终态且不再占用幂等键（需要改权限文件或扩展协议）
    for (const terminal of DELIVERY_TERMINAL_STATES.filter((state) => state !== 'confirmed')) {
      expect(DELIVERY_ACTIVE_STATES.includes(terminal)).toBe(false)
    }
  })

  it('幂等键覆盖设备、类型与到期时间，且不冲突', () => {
    const base = { projectId: 'proj-a', deviceId: 'dev-1', kind: 'issue' as const, expiresAt: '2027-01-01T00:00:00Z' }
    expect(deliveryIdempotencyKey(base)).toBe(deliveryIdempotencyKey(base))
    expect(deliveryIdempotencyKey(base)).not.toBe(deliveryIdempotencyKey({ ...base, deviceId: 'dev-2' }))
    expect(deliveryIdempotencyKey(base)).not.toBe(deliveryIdempotencyKey({ ...base, kind: 'renew' }))
    expect(deliveryIdempotencyKey(base)).not.toBe(
      deliveryIdempotencyKey({ ...base, expiresAt: '2027-02-01T00:00:00Z' })
    )
  })

  it('部分唯一索引的活跃集合与 DELIVERY_ACTIVE_STATES 完全一致', () => {
    for (const state of DELIVERY_STATES) {
      const database = freshDb()
      insertDeliveryOrder(database, orderOf({ orderId: `ord-${state}`, state }))
      const insertSameKey = (): void => {
        insertDeliveryOrder(database, orderOf({ orderId: `ord-dup-${state}`, licenseId: 'MCH-2', state: 'generated' }))
      }
      if (isDeliveryActiveState(state)) {
        expect(() => insertSameKey()).toThrow()
      } else {
        expect(() => insertSameKey()).not.toThrow()
      }
      database.close()
      opened.pop()
    }
  })
})

describe('派发订单仓储', () => {
  it('findActiveDeliveryOrder 只返回进行中的订单，失败订单不阻塞重试', () => {
    const database = freshDb()
    insertDeliveryOrder(database, orderOf())
    expect(
      findActiveDeliveryOrder(database, {
        projectId: 'proj-a',
        deviceId: 'dev-1',
        kind: 'issue',
        expiresAt: '2027-01-01T00:00:00Z'
      })?.orderId
    ).toBe('ord-1')

    updateDeliveryOrderState(database, {
      orderId: 'ord-1',
      state: 'failed',
      at: '2026-10-24T01:00:00Z',
      lastError: 'socket closed'
    })
    expect(
      findActiveDeliveryOrder(database, {
        projectId: 'proj-a',
        deviceId: 'dev-1',
        kind: 'issue',
        expiresAt: '2027-01-01T00:00:00Z'
      })
    ).toBeNull()
  })

  it('状态更新保留首次写入的 sentAt / confirmedAt，并累加尝试次数', () => {
    const database = freshDb()
    insertDeliveryOrder(database, orderOf())
    updateDeliveryOrderState(database, {
      orderId: 'ord-1',
      state: 'queued',
      at: '2026-10-24T00:10:00Z',
      lastError: null
    })
    updateDeliveryOrderState(database, {
      orderId: 'ord-1',
      state: 'sent',
      at: '2026-10-24T00:20:00Z',
      lastError: null,
      sentAt: '2026-10-24T00:20:00Z'
    })
    updateDeliveryOrderState(database, {
      orderId: 'ord-1',
      state: 'confirmed',
      at: '2026-10-24T00:30:00Z',
      lastError: null,
      confirmedAt: '2026-10-24T00:30:00Z'
    })
    incrementDeliveryAttempts(database, 'ord-1', '2026-10-24T00:31:00Z')

    const order = findDeliveryOrder(database, 'ord-1')
    expect(order?.state).toBe('confirmed')
    expect(order?.sentAt).toBe('2026-10-24T00:20:00Z')
    expect(order?.confirmedAt).toBe('2026-10-24T00:30:00Z')
    expect(order?.attempts).toBe(1)
    expect(order?.updatedAt).toBe('2026-10-24T00:31:00Z')
  })

  it('按设备与状态查询订单，默认按创建时间倒序', () => {
    const database = freshDb()
    insertDeliveryOrder(
      database,
      orderOf({ orderId: 'ord-a', createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' })
    )
    insertDeliveryOrder(
      database,
      orderOf({
        orderId: 'ord-b',
        deviceId: 'dev-2',
        createdAt: '2026-10-24T02:00:00Z',
        updatedAt: '2026-10-24T02:00:00Z'
      })
    )
    expect(listDeliveryOrders(database).map((item) => item.orderId)).toEqual(['ord-b', 'ord-a'])
    expect(listDeliveryOrders(database, { deviceId: 'dev-1' }).map((item) => item.orderId)).toEqual(['ord-a'])
    expect(listDeliveryOrders(database, { state: 'generated' })).toHaveLength(2)
    expect(listDeliveryOrders(database, { state: 'sent' })).toHaveLength(0)
    expect(listDeliveryOrders(database, { limit: 1 })).toHaveLength(1)
  })
})

describe('设备元数据与通信记录仓储', () => {
  it('设备元数据可写入并更新，按项目过滤', () => {
    const database = freshDb()
    database.exec(
      "INSERT INTO projects (project_id, name, status, created_at) VALUES ('proj-b', 'B', 'active', '2026-10-24T00:00:00Z')"
    )
    database.exec(
      "INSERT INTO devices (project_id, device_id, registered_at) VALUES ('proj-b', 'dev-9', '2026-10-24T00:00:00Z')"
    )
    upsertDeviceMeta(database, {
      projectId: 'proj-a',
      deviceId: 'dev-1',
      label: '展厅主机',
      lastIp: '192.168.1.10',
      lastSeenAt: '2026-10-24T00:00:00Z',
      lastPullResult: 'unchanged',
      updatedAt: '2026-10-24T00:00:00Z'
    })
    upsertDeviceMeta(database, {
      projectId: 'proj-a',
      deviceId: 'dev-1',
      label: '展厅主机（改名）',
      lastIp: '192.168.1.11',
      lastSeenAt: '2026-10-24T01:00:00Z',
      lastPullResult: 'issued',
      updatedAt: '2026-10-24T01:00:00Z'
    })
    upsertDeviceMeta(database, {
      projectId: 'proj-b',
      deviceId: 'dev-9',
      label: '备用机',
      lastIp: null,
      lastSeenAt: null,
      lastPullResult: null,
      updatedAt: '2026-10-24T00:00:00Z'
    })

    const all = listDeviceMeta(database)
    expect(all).toHaveLength(2)
    const first = all.find((item) => item.deviceId === 'dev-1')
    expect(first?.label).toBe('展厅主机（改名）')
    expect(first?.lastIp).toBe('192.168.1.11')
    expect(first?.lastPullResult).toBe('issued')
    expect(listDeviceMeta(database, { projectId: 'proj-b' }).map((item) => item.deviceId)).toEqual(['dev-9'])
  })

  it('通信记录按设备可查，包含被拒请求与订单关联', () => {
    const database = freshDb()
    insertDeliveryOrder(database, orderOf())
    const id = appendDeviceRequest(database, {
      at: '2026-10-24T00:00:00Z',
      projectId: 'proj-a',
      deviceId: 'dev-1',
      ip: '192.168.1.10',
      kind: 'pull',
      currentLicenseId: 'MCH-OLD',
      currentExpiresAt: '2026-12-01T00:00:00Z',
      result: 'issued',
      reason: null,
      orderId: 'ord-1'
    })
    appendDeviceRequest(database, {
      at: '2026-10-24T00:05:00Z',
      projectId: 'proj-a',
      deviceId: 'dev-unknown',
      ip: '192.168.1.77',
      kind: 'pull',
      currentLicenseId: null,
      currentExpiresAt: null,
      result: 'denied',
      reason: 'device_not_registered',
      orderId: null
    })

    expect(id).toBeGreaterThan(0)
    const forDevice = listDeviceRequests(database, { deviceId: 'dev-1' })
    expect(forDevice).toHaveLength(1)
    expect(forDevice[0]?.orderId).toBe('ord-1')
    expect(forDevice[0]?.currentLicenseId).toBe('MCH-OLD')

    const unknown = listDeviceRequests(database, { deviceId: 'dev-unknown' })
    expect(unknown[0]?.result).toBe('denied')
    expect(unknown[0]?.reason).toBe('device_not_registered')

    expect(listDeviceRequests(database, { projectId: 'proj-a' })).toHaveLength(2)
  })

  it('状态枚举在写入层就被拒绝（不依赖前端判断）', () => {
    const database = freshDb()
    expect(() =>
      database.exec(
        `INSERT INTO delivery_orders (order_id, kind, state, license_id, project_id, device_id, control_license_id,
           expires_at, created_at, updated_at, requested_by)
         VALUES ('ord-bad', 'issue', 'installed', 'MCH-1', 'proj-a', 'dev-1', 'VND-1',
           '2027-01-01T00:00:00Z', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z', 'tester')`
      )
    ).toThrow()

    // 合法状态可以直接落库（最终一致性由服务层状态机保证）
    const states: DeliveryState[] = ['generated']
    for (const state of states) {
      expect(() => insertDeliveryOrder(database, orderOf({ orderId: `ord-${state}`, state }))).not.toThrow()
    }
  })
})
