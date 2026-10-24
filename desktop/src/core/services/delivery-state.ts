import {
  DELIVERY_ACTIVE_STATES,
  DELIVERY_TERMINAL_STATES,
  DELIVERY_STATES,
  type DeliveryKind,
  type DeliveryState
} from '@shared/license/delivery-contract'
import { ServiceError } from './errors'

/**
 * 派发订单状态机（纯函数，无 I/O）。
 *
 * 设计原则：
 * - CONFIRMED 只能由"子机自报持有该授权"触发，任何本地写入成功都不允许直接进入；
 * - DENIED / UNSUPPORTED 是终态：权限被拒需要先改权限文件，协议不支持需要先扩展协议；
 * - FAILED / TIMEOUT 允许重试（回到 QUEUED），但重试不产生新订单——复用同一条订单并累加 attempts，
 *   只有失败之后再次派发才会让数据库插入新订单（见 delivery_orders_active_unique 部分唯一索引）。
 */
const ALLOWED_TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  // 本地已生成：可入队，也可以在同一个请求内直接发送（Hub 无队列进程），或被权限/协议拒绝
  generated: ['queued', 'sent', 'failed', 'denied', 'unsupported'],
  // 已入队：发送成功、等待设备超时、发送前失败，或准备阶段被拒
  queued: ['sent', 'timeout', 'failed', 'denied', 'unsupported'],
  // 已发送：只有子机自报才算确认；发现协议不兼容时可直接判为 unsupported
  sent: ['confirmed', 'timeout', 'failed', 'unsupported'],
  // 已确认：终态，不再变化（续期会产生新订单）
  confirmed: [],
  // 失败/超时：可重试
  failed: ['queued', 'unsupported'],
  timeout: ['queued', 'unsupported'],
  denied: [],
  unsupported: []
}

export function canTransitionDelivery(from: DeliveryState, to: DeliveryState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export function isDeliveryState(value: unknown): value is DeliveryState {
  return typeof value === 'string' && (DELIVERY_STATES as readonly string[]).includes(value)
}

export function isDeliveryActiveState(state: DeliveryState): boolean {
  return DELIVERY_ACTIVE_STATES.includes(state)
}

export function isDeliveryTerminalState(state: DeliveryState): boolean {
  return DELIVERY_TERMINAL_STATES.includes(state)
}

/** 状态转换守卫：非法转换直接抛 conflict，避免前端或并发路径把状态改成"看起来完成" */
export function assertDeliveryTransition(from: DeliveryState, to: DeliveryState): void {
  if (!canTransitionDelivery(from, to)) {
    throw new ServiceError('conflict', `派发订单状态不允许从 ${from} 变为 ${to}`)
  }
}

export interface DeliveryKeyInput {
  readonly projectId: string
  readonly deviceId: string
  readonly kind: DeliveryKind
  readonly expiresAt: string
}

/**
 * 订单幂等键：与数据库部分唯一索引 delivery_orders_active_unique 使用同一组字段。
 * 只用于日志与查询参数拼装，不落库（唯一性由索引强制）。
 */
export function deliveryIdempotencyKey(input: DeliveryKeyInput): string {
  return [input.projectId, input.deviceId, input.kind, input.expiresAt].join('|')
}
