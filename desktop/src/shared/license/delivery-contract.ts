/**
 * 派发订单、设备元数据与设备通信记录的跨进程契约。
 * 约束：与 service-contract 一样不含 Node.js 依赖，渲染进程可安全引用。
 *
 * 核心语义（阶段 B 设计）：中控本地状态 ≠ 子机实际安装状态。
 * - GENERATED：授权文件已在本地生成，并完成本地验签/摘要核对
 * - QUEUED：已进入派发队列，等待设备连接
 * - SENT：已写入网络连接；**不能**据此认为设备已安装
 * - CONFIRMED：子机在后续拉取请求中自报持有该 license_id（现有协议下唯一可信证据）
 * - FAILED / TIMEOUT / DENIED：分别对应实现失败、网络超时/断开、权限或身份拒绝
 * - UNSUPPORTED：当前协议无法送达（例如撤销），不是失败，也不是成功
 */

export const DELIVERY_KINDS = ['issue', 'renew', 'revoke'] as const
export type DeliveryKind = (typeof DELIVERY_KINDS)[number]

export const DELIVERY_STATES = [
  'generated',
  'queued',
  'sent',
  'confirmed',
  'failed',
  'timeout',
  'denied',
  'unsupported'
] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/** 仍在进行中（占用"同设备同类型同到期时间"唯一性）的状态 */
export const DELIVERY_ACTIVE_STATES: readonly DeliveryState[] = ['generated', 'queued', 'sent', 'confirmed']

/** 不会再自动变化的状态 */
export const DELIVERY_TERMINAL_STATES: readonly DeliveryState[] = ['confirmed', 'denied', 'unsupported']

/** 失败后允许通过重试回到队列的状态 */
export const DELIVERY_RETRYABLE_STATES: readonly DeliveryState[] = ['failed', 'timeout']

export interface DeliveryOrderDto {
  readonly orderId: string
  readonly kind: DeliveryKind
  readonly state: DeliveryState
  readonly licenseId: string
  readonly projectId: string
  readonly deviceId: string
  readonly controlLicenseId: string
  readonly expiresAt: string
  readonly attempts: number
  readonly lastError: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly sentAt: string | null
  readonly confirmedAt: string | null
  /** 触发该订单的操作者（审计用，不含密码/密钥） */
  readonly requestedBy: string
}

/** 设备的展示与通信元数据；设备身份仍以 devices(project_id, device_id) 为准 */
export interface DeviceMetaDto {
  readonly projectId: string
  readonly deviceId: string
  readonly label: string
  readonly lastIp: string | null
  readonly lastSeenAt: string | null
  /** 最近一次拉取的结果码（例如 issued / unchanged / denied / timeout） */
  readonly lastPullResult: string | null
  readonly updatedAt: string
}

export const DEVICE_REQUEST_KINDS = ['discover', 'pull'] as const
export type DeviceRequestKind = (typeof DEVICE_REQUEST_KINDS)[number]

/** 设备通信原始记录：包含未登记设备的被拒请求，因此不对 devices 设外键 */
export interface DeviceRequestDto {
  readonly id: number
  readonly at: string
  readonly projectId: string
  readonly deviceId: string
  readonly ip: string | null
  readonly kind: DeviceRequestKind
  /** 设备自报的当前授权 ID（只有子机验签通过后才会给出） */
  readonly currentLicenseId: string | null
  readonly currentExpiresAt: string | null
  /** 服务端处理结果码，成功与拒绝都记录 */
  readonly result: string
  readonly reason: string | null
  readonly orderId: string | null
}
