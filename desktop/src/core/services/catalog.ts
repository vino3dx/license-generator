import { createHash } from 'node:crypto'
import {
  countBoundDevices,
  findCurrentLicense,
  findDevice,
  findProject,
  insertDevice,
  insertProject,
  listDevices,
  listProjects,
  updateDeviceLock,
  updateDeviceRegistration,
  updateDeviceUnbind,
  updateProjectName,
  withTransaction
} from '@core/db'
import { parseLicenseContainer } from '@core/license/container'
import { formatTimestamp } from '@core/license/encoding'
import { isLicenseError } from '@core/license/errors'
import { verifyMachineLicense } from '@core/license/machine-license'
import { verifyVendorCertificate } from '@core/license/vendor-license'
import { parseEnvelope } from '@core/license/envelope'
import type {
  DeviceDto,
  DeviceLicenseStatusDto,
  LicenseFileCheckDto,
  ProjectDto
} from '@shared/license/service-contract'
import { writeAudit } from './audit'
import { loadVerifiedControlCertificate } from './control'
import type { ResolvedDependencies } from './context'
import { ServiceError, assertIdentifier } from './errors'

const MAX_NAME_LENGTH = 128
const MAX_REASON_LENGTH = 200

export function createProject(
  deps: ResolvedDependencies,
  input: { readonly projectId: string; readonly name: string }
): ProjectDto {
  const projectId = assertIdentifier(input.projectId, 'project_id')
  const name = assertName(input.name)
  const at = formatTimestamp(deps.now())

  if (findProject(deps.database, projectId) !== null) {
    throw new ServiceError('conflict', `项目 ${projectId} 已存在`)
  }

  const project: ProjectDto = { projectId, name, status: 'active', createdAt: at }
  withTransaction(deps.database, () => {
    insertProject(deps.database, project)
    writeAudit(deps, {
      at,
      action: 'project_create',
      targetType: 'project',
      targetId: projectId,
      result: 'success',
      errorCode: null,
      context: JSON.stringify({ name })
    })
  })
  return project
}

export function listProjectsService(deps: ResolvedDependencies): ProjectDto[] {
  return listProjects(deps.database)
}

/** 编辑项目名称。project_id 是稳定标识，不提供修改入口。 */
export function updateProject(
  deps: ResolvedDependencies,
  input: { readonly projectId: string; readonly name: string }
): ProjectDto {
  const projectId = assertIdentifier(input.projectId, 'project_id')
  const name = assertName(input.name)
  const existing = findProject(deps.database, projectId)
  if (existing === null) {
    throw new ServiceError('not_found', `项目 ${projectId} 不存在`)
  }
  if (existing.name === name) {
    return existing
  }

  const at = formatTimestamp(deps.now())
  withTransaction(deps.database, () => {
    updateProjectName(deps.database, projectId, name)
    writeAudit(deps, {
      at,
      action: 'project_update',
      targetType: 'project',
      targetId: projectId,
      result: 'success',
      errorCode: null,
      context: JSON.stringify({ from: existing.name, to: name })
    })
  })
  return { ...existing, name }
}

export function registerDevice(
  deps: ResolvedDependencies,
  input: { readonly projectId: string; readonly deviceId: string }
): DeviceDto {
  const projectId = assertIdentifier(input.projectId, 'project_id')
  const deviceId = assertIdentifier(input.deviceId, 'device_id')
  const at = formatTimestamp(deps.now())

  const project = findProject(deps.database, projectId)
  if (project === null) {
    throw new ServiceError('not_found', `项目 ${projectId} 不存在`)
  }
  if (project.status !== 'active') {
    throw new ServiceError('conflict', `项目 ${projectId} 已归档，不能登记设备`)
  }

  // 额度来自中控证书，没有有效证书就无法判断是否超发
  const certificate = loadVerifiedControlCertificate(deps)
  if (certificate.scope !== null && !certificate.scope.includes(projectId)) {
    throw new ServiceError('project_not_in_scope', `项目 ${projectId} 不在中控授权范围内`)
  }

  const existing = findDevice(deps.database, projectId, deviceId)
  if (existing !== null && existing.unbindAt === null) {
    // 幂等：重复登记不产生新记录、不额外占用额度
    return existing
  }

  // 走到这里说明这台设备当前不占用名额，登记会新增一个名额
  const occupied = countBoundDevices(deps.database, certificate.scope)
  if (occupied + 1 > certificate.payload.max_devices) {
    writeAudit(deps, {
      at,
      action: 'device_register',
      targetType: 'device',
      targetId: deviceId,
      result: 'failure',
      errorCode: 'device_quota_exceeded',
      context: JSON.stringify({ projectId, used: occupied, max: certificate.payload.max_devices })
    })
    throw new ServiceError('device_quota_exceeded', '设备额度已用尽', {
      used: occupied,
      max: certificate.payload.max_devices
    })
  }

  const record: DeviceDto = {
    projectId,
    deviceId,
    registeredAt: at,
    locked: false,
    lockedAt: null,
    unbindAt: null
  }
  withTransaction(deps.database, () => {
    if (existing === null) {
      insertDevice(deps.database, record)
    } else {
      updateDeviceRegistration(deps.database, projectId, deviceId, at)
    }
    writeAudit(deps, {
      at,
      action: 'device_register',
      targetType: 'device',
      targetId: deviceId,
      result: 'success',
      errorCode: null,
      context: JSON.stringify({ projectId, rebind: existing !== null })
    })
  })
  return record
}

export function listDevicesService(
  deps: ResolvedDependencies,
  options: { readonly projectId?: string; readonly includeUnbound?: boolean } = {}
): DeviceDto[] {
  if (options.projectId !== undefined) {
    assertIdentifier(options.projectId, 'project_id')
  }
  return listDevices(deps.database, options)
}

export function unbindDevice(
  deps: ResolvedDependencies,
  input: { readonly projectId: string; readonly deviceId: string; readonly reason: string }
): DeviceDto {
  const projectId = assertIdentifier(input.projectId, 'project_id')
  const deviceId = assertIdentifier(input.deviceId, 'device_id')
  const reason = assertReason(input.reason)
  const at = formatTimestamp(deps.now())

  const device = findDevice(deps.database, projectId, deviceId)
  if (device === null || device.unbindAt !== null) {
    throw new ServiceError('not_found', '设备未登记或已解绑')
  }

  withTransaction(deps.database, () => {
    updateDeviceUnbind(deps.database, projectId, deviceId, at)
    writeAudit(deps, {
      at,
      action: 'device_unbind',
      targetType: 'device',
      targetId: deviceId,
      result: 'success',
      errorCode: null,
      context: JSON.stringify({ projectId, reason })
    })
  })

  return { ...device, unbindAt: at, locked: false, lockedAt: null }
}

export function setDeviceLock(
  deps: ResolvedDependencies,
  input: { readonly projectId: string; readonly deviceId: string; readonly locked: boolean; readonly reason?: string }
): DeviceDto {
  const projectId = assertIdentifier(input.projectId, 'project_id')
  const deviceId = assertIdentifier(input.deviceId, 'device_id')
  const reason = input.reason === undefined ? null : assertReason(input.reason)
  const at = formatTimestamp(deps.now())

  const device = findDevice(deps.database, projectId, deviceId)
  if (device === null) {
    throw new ServiceError('not_found', `设备 ${deviceId} 不存在`)
  }
  if (device.unbindAt !== null) {
    throw new ServiceError('device_unbound', `设备 ${deviceId} 已解绑`)
  }

  withTransaction(deps.database, () => {
    updateDeviceLock(deps.database, projectId, deviceId, input.locked, input.locked ? at : null)
    writeAudit(deps, {
      at,
      action: input.locked ? 'device_lock' : 'device_unlock',
      targetType: 'device',
      targetId: deviceId,
      result: 'success',
      errorCode: null,
      context: JSON.stringify({ projectId, reason })
    })
  })

  return {
    ...device,
    locked: input.locked,
    lockedAt: input.locked ? at : null
  }
}

/**
 * 设备授权状态：数据库记录 + 授权文件实校验。
 * 数据库状态只用于定位文件，不替代验签。
 */
export function getDeviceLicenseStatus(
  deps: ResolvedDependencies,
  input: { readonly projectId: string; readonly deviceId: string }
): DeviceLicenseStatusDto {
  const projectId = assertIdentifier(input.projectId, 'project_id')
  const deviceId = assertIdentifier(input.deviceId, 'device_id')

  const device = findDevice(deps.database, projectId, deviceId)
  if (device === null) {
    throw new ServiceError('not_found', `设备 ${deviceId} 不存在`)
  }
  const license = findCurrentLicense(deps.database, projectId, deviceId)
  if (license === null) {
    return { device, license: null, file: { ok: false, code: 'no_license' } }
  }
  return { device, license, file: checkLicenseFile(deps, license.fileName, license.payloadSha256, projectId, deviceId) }
}

/**
 * license.dat 现在是容器格式（内嵌 control.cert）。校验逻辑与子机一致（约定 v3.1 §4）：
 * 解析容器 → 厂商公钥验内嵌中控证书 → 证书内委托公钥验子机授权 → 比对数据库摘要。
 */
export function checkLicenseFile(
  deps: ResolvedDependencies,
  fileName: string,
  expectedSha256: string,
  projectId: string,
  deviceId: string
): LicenseFileCheckDto {
  if (!deps.files.exists(fileName)) {
    return { ok: false, code: 'file_missing' }
  }
  if (deps.vendorKeyObject === null) {
    return { ok: false, code: 'vendor_key_missing' }
  }
  const text = deps.files.read(fileName)
  try {
    const container = parseLicenseContainer(new TextEncoder().encode(text))
    const certificate = verifyVendorCertificate(container.control, deps.vendorKeyObject, deps.now().getTime())
    verifyMachineLicense(container.license, certificate, { projectId, deviceId }, deps.now().getTime())
    const opened = parseEnvelope(container.license, 'machine-license')
    const digest = createHash('sha256').update(opened.payloadBytes).digest('hex')
    if (digest !== expectedSha256) {
      return { ok: false, code: 'file_hash_mismatch' }
    }
    return { ok: true, code: null }
  } catch (error) {
    if (isLicenseError(error)) {
      return { ok: false, code: error.code }
    }
    if (error instanceof ServiceError) {
      return { ok: false, code: error.code }
    }
    return { ok: false, code: 'unexpected' }
  }
}

export function requireDevice(
  deps: ResolvedDependencies,
  projectId: string,
  deviceId: string
): DeviceDto {
  const device = findDevice(deps.database, projectId, deviceId)
  if (device === null) {
    throw new ServiceError('not_found', `设备 ${deviceId} 不存在`)
  }
  if (device.unbindAt !== null) {
    throw new ServiceError('device_unbound', `设备 ${deviceId} 已解绑`)
  }
  return device
}

function assertName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ServiceError('invalid_argument', '项目名称必须是字符串')
  }
  const name = value.trim()
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new ServiceError('invalid_argument', `项目名称长度必须为 1..${MAX_NAME_LENGTH}`)
  }
  return name
}

function assertReason(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ServiceError('invalid_argument', '原因必须是字符串')
  }
  const reason = value.trim()
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    throw new ServiceError('invalid_argument', `原因长度必须为 1..${MAX_REASON_LENGTH}`)
  }
  return reason
}
