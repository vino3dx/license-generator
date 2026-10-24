import { randomBytes } from 'node:crypto'
import {
  appendDeviceRequest,
  countBoundDevices,
  findActiveDeliveryOrder,
  findActiveDeviceById,
  findCurrentLicense,
  findLicense,
  incrementDeliveryAttempts,
  insertDeliveryOrder,
  listDeliveryOrders,
  listDeviceRequests,
  updateDeliveryOrderState
} from '@core/db'
import { formatTimestamp, parseTimestamp } from '@core/license/encoding'
import type { LicenseDto } from '@shared/license/service-contract'
import type { DeliveryState, DeviceRequestDto } from '@shared/license/delivery-contract'
import {
  GODOT_PLUGIN_SCHEMA_VERSION,
  type PullResultDto
} from '@shared/license/hub-contract'
import { LICENSE_SCHEMA_VERSION } from '@shared/license/protocol'
import { writeAudit } from './audit'
import { loadVerifiedControlCertificate } from './control'
import type { ResolvedDependencies } from './context'
import { assertDeliveryTransition } from './delivery-state'
import { isServiceError } from './errors'
import { issueLicense, resolveDefaultExpiry } from './issuance'

/**
 * 局域网下发（Hub）的领域逻辑：把一个来自 Godot 的拉取请求映射成
 * "复用现有授权 / 生成新授权 / 明确拒绝"，并维护派发订单状态与留证。
 *
 * 安全约束：
 * - 请求里的 device_id / project_id / current_license_id 全部不可信，
 *   必须与 devices 表、中控证书范围、licenses 表交叉核对；
 * - 缓存与"已发送"都不等于客户端安装成功，CONFIRMED 只能由子机自报的
 *   current_license_id 触发，且审计里标注 basis=client_self_report；
 * - 当前中控签发 v3，而仓库内 Godot 插件只接受 v1：默认拒绝下发，避免假派发。
 */

export interface HubPullInput {
  readonly deviceId: string
  readonly projectId: string
  /** 设备自报的当前授权 ID（空串表示没有本地授权） */
  readonly currentLicenseId: string
  readonly lastExpiresAt: string | null
  readonly ip: string | null
  /**
   * 仅用于中控侧自校验/预演：即使插件协议版本不匹配也生成授权，
   * 以便用 desktop 自身的 v3 校验链验证产物有效。生产路径不设置。
   */
  readonly allowIncompatibleSchema?: boolean
}

export type HubPullOutcome = PullResultDto

/** 中控签发格式与已知插件期望是否一致 */
export function isClientSchemaSupported(): boolean {
  // 运行期比较（两个常量可能在不同发布中分别升级，不能写成编译期恒等比较）
  return Number(LICENSE_SCHEMA_VERSION) === Number(GODOT_PLUGIN_SCHEMA_VERSION)
}

export function clientSchemaReason(): string | null {
  if (isClientSchemaSupported()) {
    return null
  }
  return `中控签发 schema_version=${LICENSE_SCHEMA_VERSION}，仓库内 Godot 插件只接受 schema_version=${GODOT_PLUGIN_SCHEMA_VERSION}`
}

export function handleHubPull(deps: ResolvedDependencies, input: HubPullInput): HubPullOutcome {
  const now = deps.now()
  const at = formatTimestamp(now)

  const device = findActiveDeviceById(deps.database, input.deviceId)
  if (device === null || device.unbindAt !== null) {
    return finish(deps, input, at, { status: 'denied', license: '', reason: 'device_not_registered', orderId: null })
  }
  if (device.projectId !== input.projectId) {
    return finish(deps, input, at, { status: 'denied', license: '', reason: 'device_project_mismatch', orderId: null })
  }

  let scope: readonly string[] | null
  let maxDevices: number
  try {
    const certificate = loadVerifiedControlCertificate(deps)
    scope = certificate.scope
    maxDevices = certificate.payload.max_devices
  } catch (error) {
    return finish(deps, input, at, {
      status: 'denied',
      license: '',
      reason: isServiceError(error) ? error.code : 'control_certificate_invalid',
      orderId: null
    })
  }
  if (scope !== null && !scope.includes(input.projectId)) {
    return finish(deps, input, at, { status: 'denied', license: '', reason: 'project_not_in_scope', orderId: null })
  }
  if (countBoundDevices(deps.database, scope) > maxDevices) {
    return finish(deps, input, at, { status: 'denied', license: '', reason: 'device_quota_exceeded', orderId: null })
  }

  // 子机自报当前持有某张授权：作为"已确认安装"的有限证据（协议无 ACK，非密码学认证）
  const selfReported = resolveSelfReported(deps, input)
  if (selfReported !== null) {
    confirmSentOrders(deps, input, selfReported, at)
  }

  // 已持有当前有效授权：返回 unchanged，不重复签发
  const current = findCurrentLicense(deps.database, input.projectId, input.deviceId)
  if (
    current !== null &&
    selfReported !== null &&
    current.licenseId === selfReported.licenseId &&
    parseTimestamp(current.expiresAt) > now.getTime()
  ) {
    return finish(deps, input, at, { status: 'unchanged', license: '', reason: 'already_current', orderId: null })
  }

  // 协议版本不兼容：不动订单数据，明确拒绝，避免"发送成功"的假象
  if (input.allowIncompatibleSchema !== true && !isClientSchemaSupported()) {
    markActiveOrdersUnsupported(deps, input, at)
    return finish(deps, input, at, {
      status: 'denied',
      license: '',
      reason: 'license_schema_mismatch',
      orderId: null
    })
  }

  const expiresAt = resolveDefaultExpiry(deps)
  const activeOrder = findActiveDeliveryOrder(deps.database, {
    projectId: input.projectId,
    deviceId: input.deviceId,
    kind: 'issue',
    expiresAt
  })
  if (activeOrder !== null) {
    const fileName = `${activeOrder.licenseId}.json`
    if (deps.files.exists(fileName)) {
      // 幂等：复用同一订单与授权文件，不重复签发
      incrementDeliveryAttempts(deps.database, activeOrder.orderId, at)
      if (activeOrder.state !== 'confirmed') {
        transition(deps, activeOrder.orderId, activeOrder.state, 'sent', at, null)
      }
      return finish(deps, input, at, {
        status: 'issued',
        license: deps.files.read(fileName),
        reason: activeOrder.state === 'confirmed' ? 'reused_confirmed_order' : 'reused_order',
        orderId: activeOrder.orderId
      })
    }
  }

  let license: LicenseDto
  try {
    license = issueLicense(deps, {
      projectId: input.projectId,
      deviceId: input.deviceId,
      expiresAt
    })
  } catch (error) {
    return finish(deps, input, at, {
      status: 'denied',
      license: '',
      reason: isServiceError(error) ? error.code : 'license_issue_failed',
      orderId: null
    })
  }

  const orderId = generateOrderId(now)
  insertDeliveryOrder(deps.database, {
    orderId,
    kind: 'issue',
    state: 'generated',
    licenseId: license.licenseId,
    projectId: license.projectId,
    deviceId: license.deviceId,
    controlLicenseId: license.controlLicenseId,
    expiresAt: license.expiresAt,
    attempts: 0,
    lastError: null,
    createdAt: at,
    updatedAt: at,
    sentAt: null,
    confirmedAt: null,
    requestedBy: deps.actor
  })
  transition(deps, orderId, 'generated', 'sent', at, null)
  incrementDeliveryAttempts(deps.database, orderId, at)

  return finish(deps, input, at, {
    status: 'issued',
    license: deps.files.read(license.fileName),
    reason: '',
    orderId
  })
}

/** 设备自报的授权必须真实存在于本库、且属于同一设备与工程，否则忽略（不据此确认） */
function resolveSelfReported(deps: ResolvedDependencies, input: HubPullInput): LicenseDto | null {
  if (input.currentLicenseId.length === 0) {
    return null
  }
  const license = findLicense(deps.database, input.currentLicenseId)
  if (license === null) {
    return null
  }
  if (license.deviceId !== input.deviceId || license.projectId !== input.projectId) {
    return null
  }
  if (license.status !== 'active' || license.fileState !== 'written') {
    return null
  }
  return license
}

/** 子机自报持有该授权 → 把此前 sent 的订单升级为 confirmed（并记录证据来源） */
function confirmSentOrders(
  deps: ResolvedDependencies,
  input: HubPullInput,
  license: LicenseDto,
  at: string
): void {
  const orders = listDeliveryOrders(deps.database, { deviceId: input.deviceId, limit: 200 })
  for (const order of orders) {
    if (order.licenseId !== license.licenseId || order.projectId !== input.projectId) {
      continue
    }
    if (order.state !== 'sent') {
      continue
    }
    transition(deps, order.orderId, order.state, 'confirmed', at, null)
    writeAudit(deps, {
      at,
      action: 'delivery_confirmed',
      targetType: 'delivery',
      targetId: order.orderId,
      result: 'success',
      errorCode: null,
      context: JSON.stringify({
        licenseId: license.licenseId,
        deviceId: input.deviceId,
        basis: 'client_self_report'
      })
    })
  }
}

function markActiveOrdersUnsupported(
  deps: ResolvedDependencies,
  input: HubPullInput,
  at: string
): void {
  const orders = listDeliveryOrders(deps.database, { deviceId: input.deviceId, limit: 200 })
  for (const order of orders) {
    if (order.projectId !== input.projectId) {
      continue
    }
    if (order.state !== 'sent' && order.state !== 'queued' && order.state !== 'generated') {
      continue
    }
    transition(deps, order.orderId, order.state, 'unsupported', at, 'license_schema_mismatch')
  }
}

function transition(
  deps: ResolvedDependencies,
  orderId: string,
  from: DeliveryState,
  to: DeliveryState,
  at: string,
  reason: string | null
): void {
  if (from === to) {
    updateDeliveryOrderState(deps.database, {
      orderId,
      state: to,
      at,
      lastError: reason,
      sentAt: to === 'sent' ? at : undefined
    })
    return
  }
  assertDeliveryTransition(from, to)
  updateDeliveryOrderState(deps.database, {
    orderId,
    state: to,
    at,
    lastError: reason,
    sentAt: to === 'sent' ? at : undefined,
    confirmedAt: to === 'confirmed' ? at : undefined
  })
}

/** 记录通信留证 + 审计，返回给网络层的统一结果 */
function finish(
  deps: ResolvedDependencies,
  input: HubPullInput,
  at: string,
  outcome: HubPullOutcome
): HubPullOutcome {
  try {
    appendDeviceRequest(deps.database, {
      at,
      projectId: input.projectId,
      deviceId: input.deviceId,
      ip: input.ip,
      kind: 'pull',
      currentLicenseId: input.currentLicenseId.length === 0 ? null : input.currentLicenseId,
      currentExpiresAt: input.lastExpiresAt,
      result: outcome.status,
      reason: outcome.reason.length === 0 ? null : outcome.reason,
      orderId: outcome.orderId
    })
  } catch {
    // 留证失败不能影响响应；下一次请求会再次记录
  }
  writeAudit(deps, {
    at,
    action: 'delivery_pull',
    targetType: 'device',
    targetId: input.deviceId,
    result: outcome.status === 'denied' ? 'failure' : 'success',
    errorCode: outcome.status === 'denied' ? outcome.reason : null,
    context: JSON.stringify({
      projectId: input.projectId,
      status: outcome.status,
      reason: outcome.reason,
      orderId: outcome.orderId,
      ip: input.ip
    })
  })
  return outcome
}

function generateOrderId(now: Date): string {
  const stamp = formatTimestamp(now).replace(/[-:TZ]/g, '').slice(0, 14)
  return `DLV-${stamp}-${randomBytes(3).toString('hex').toUpperCase()}`
}

/** 最近通信记录（只读，供 IPC/UI 展示） */
export function listHubRequests(
  deps: ResolvedDependencies,
  options: { readonly limit?: number; readonly deviceId?: string } = {}
): DeviceRequestDto[] {
  return listDeviceRequests(deps.database, options)
}
