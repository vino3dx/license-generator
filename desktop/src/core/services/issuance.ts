import { createHash, randomBytes } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import {
  countBoundDevices,
  deleteLicense,
  findCurrentLicense,
  insertLicense,
  listAllLicenseFileNames,
  listLicenses,
  listPendingLicenses,
  markLicenseFileState,
  setSupersededBy,
  withTransaction
} from '@core/db'
import { buildLicenseContainer } from '@core/license/container'
import { formatTimestamp, parseTimestamp } from '@core/license/encoding'
import { isLicenseError } from '@core/license/errors'
import { issueMachineLicense } from '@core/license/machine-license'
import type {
  BatchIssueResultDto,
  LicenseDto,
  QuotaUsageDto,
  ReconcileResultDto
} from '@shared/license/service-contract'
import { writeAudit } from './audit'
import { loadVerifiedControlCertificate, type VerifiedControlCertificate } from './control'
import type { ResolvedDependencies } from './context'
import { samePublicKey } from './delegated-key'
import { ServiceError, assertIdentifier } from './errors'
import { requireDevice } from './catalog'

const DEFAULT_VALIDITY_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

interface PreparedLicense {
  readonly license: LicenseDto
  readonly envelope: string
  /** 签发时所用的中控证书信封：payload 的 control_cert 与容器 control 用同一份 */
  readonly controlEnvelope: string
  /** 提交前该设备当前的授权 ID，成功后标记为 superseded_by */
  readonly supersedes: string | null
}

export interface IssueInput {
  readonly projectId: string
  readonly deviceId: string
  /** 省略时使用默认有效期（90 天，且不超过中控证书到期时间） */
  readonly expiresAt?: string
}

/**
 * 单台签发。批量与续期都走同一条路径，保证校验规则一致。
 */
export function issueLicense(deps: ResolvedDependencies, input: IssueInput): LicenseDto {
  const prepared = prepareBatch(deps, [input], 'license_issue')
  const written = commitPrepared(deps, prepared, 'license_issue')
  return written[0]!
}

export function issueLicensesBatch(
  deps: ResolvedDependencies,
  input: { readonly projectId: string; readonly deviceIds: readonly string[]; readonly expiresAt?: string }
): BatchIssueResultDto {
  const projectId = assertIdentifier(input.projectId, 'project_id')
  if (!Array.isArray(input.deviceIds) || input.deviceIds.length === 0) {
    throw new ServiceError('invalid_argument', '批量签发至少需要一台设备')
  }
  const deviceIds = [...new Set(input.deviceIds.map((id) => assertIdentifier(id, 'device_id')))]
  const inputs = deviceIds.map((deviceId) => ({ projectId, deviceId, expiresAt: input.expiresAt }))
  const prepared = prepareBatch(deps, inputs, 'license_batch_issue')
  const written = commitPrepared(deps, prepared, 'license_batch_issue')
  return { issued: written }
}

export function renewLicense(deps: ResolvedDependencies, input: IssueInput): LicenseDto {
  const projectId = assertIdentifier(input.projectId, 'project_id')
  const deviceId = assertIdentifier(input.deviceId, 'device_id')
  const current = findCurrentLicense(deps.database, projectId, deviceId)
  if (current === null) {
    throw new ServiceError('not_found', `设备 ${deviceId} 没有可续期的授权`)
  }
  const prepared = prepareBatch(deps, [input], 'license_renew')
  const written = commitPrepared(deps, prepared, 'license_renew')
  return written[0]!
}

export function listLicensesService(
  deps: ResolvedDependencies,
  options: { readonly projectId?: string; readonly deviceId?: string; readonly limit?: number } = {}
): LicenseDto[] {
  if (options.projectId !== undefined) {
    assertIdentifier(options.projectId, 'project_id')
  }
  if (options.deviceId !== undefined) {
    assertIdentifier(options.deviceId, 'device_id')
  }
  return listLicenses(deps.database, options)
}

export function getQuotaUsage(deps: ResolvedDependencies): QuotaUsageDto {
  const certificate = loadVerifiedControlCertificate(deps)
  return {
    controlLicenseId: certificate.payload.license_id,
    maxDevices: certificate.payload.max_devices,
    usedDevices: countBoundDevices(deps.database, certificate.scope)
  }
}

/**
 * 第一阶段：所有校验 + 在内存中签名。
 * 任何一台设备不满足条件都不会写入数据库或文件（全批成功策略）。
 */
function prepareBatch(
  deps: ResolvedDependencies,
  inputs: readonly IssueInput[],
  action: string
): PreparedLicense[] {
  const now = deps.now()
  const nowMs = now.getTime()
  const at = formatTimestamp(now)

  let certificate: VerifiedControlCertificate
  try {
    certificate = loadVerifiedControlCertificate(deps)
  } catch (error) {
    auditFailure(deps, action, 'control-certificate', 'active', errorCodeOf(error), null)
    throw error
  }

  const delegatedKey = requireDelegatedKey(deps, certificate, action)
  const controlExpiresAt = parseTimestamp(certificate.payload.expires_at)

  for (const input of inputs) {
    const projectId = assertIdentifier(input.projectId, 'project_id')
    const deviceId = assertIdentifier(input.deviceId, 'device_id')

    if (certificate.scope !== null && !certificate.scope.includes(projectId)) {
      auditFailure(deps, action, 'device', deviceId, 'project_not_in_scope', JSON.stringify({ projectId }))
      throw new ServiceError('project_not_in_scope', `项目 ${projectId} 不在中控授权范围内`)
    }
    try {
      requireDevice(deps, projectId, deviceId)
    } catch (error) {
      auditFailure(deps, action, 'device', deviceId, errorCodeOf(error), JSON.stringify({ projectId }))
      throw error
    }

    // 额度：登记设备数必须仍在证书允许范围内（可能是导入更小的证书后）
    const occupied = countBoundDevices(deps.database, certificate.scope)
    if (occupied > certificate.payload.max_devices) {
      auditFailure(deps, action, 'device', deviceId, 'device_quota_exceeded', JSON.stringify({ occupied }))
      throw new ServiceError('device_quota_exceeded', '已登记设备数超过中控证书额度，无法签发', {
        used: occupied,
        max: certificate.payload.max_devices
      })
    }
  }

  const prepared: PreparedLicense[] = []
  for (const input of inputs) {
    const projectId = assertIdentifier(input.projectId, 'project_id')
    const deviceId = assertIdentifier(input.deviceId, 'device_id')
    const expiresAt = resolveExpiry(input.expiresAt, nowMs, controlExpiresAt)
    const licenseId = generateLicenseId(now)

    const certificateForIssue = certificate
    const issued = issueMachineLicense(
      {
        licenseId,
        controlLicenseId: certificateForIssue.payload.license_id,
        projectId,
        deviceId,
        issuedAt: at,
        expiresAt,
        status: 'active',
        // 协议 v3：子机授权 payload 内嵌中控证书，使 license.dat 自包含
        controlCertificate: certificateForIssue.record.envelope
      },
      delegatedKey
    )

    const existing = findCurrentLicense(deps.database, projectId, deviceId)
    prepared.push({
      envelope: issued.envelope,
      controlEnvelope: certificateForIssue.record.envelope,
      supersedes: existing?.licenseId ?? null,
      license: {
        licenseId,
        projectId,
        deviceId,
        controlLicenseId: certificateForIssue.payload.license_id,
        issuedAt: at,
        expiresAt,
        status: 'active',
        payloadSha256: createHash('sha256').update(issued.payloadBytes).digest('hex'),
        fileName: `${licenseId}.json`,
        fileState: 'pending',
        supersededBy: null
      }
    })
  }

  return prepared
}

/**
 * 第二阶段：预留记录 → 原子写文件 → 标记完成。
 * 数据库无法回滚文件操作，因此失败时按相反顺序补偿（删文件、删记录）。
 */
function commitPrepared(
  deps: ResolvedDependencies,
  prepared: readonly PreparedLicense[],
  action: string
): LicenseDto[] {
  const at = formatTimestamp(deps.now())
  const certificate = loadVerifiedControlCertificate(deps)

  try {
    withTransaction(deps.database, () => {
      // 事务内重新核对额度与设备状态，避免与并发登记竞争
      const occupied = countBoundDevices(deps.database, certificate.scope)
      if (occupied > certificate.payload.max_devices) {
        throw new ServiceError('device_quota_exceeded', '已登记设备数超过中控证书额度，无法签发')
      }
      for (const item of prepared) {
        requireDevice(deps, item.license.projectId, item.license.deviceId)
        insertLicense(deps.database, item.license)
      }
    })
  } catch (error) {
    auditFailure(deps, action, 'license', prepared[0]?.license.licenseId ?? 'unknown', errorCodeOf(error), null)
    throw error
  }

  const writtenFiles: string[] = []
  try {
    for (const item of prepared) {
      // license.dat 使用容器格式：内嵌签发时校验过的 control.cert（约定 v3.1 §2），裸信封不再分发
      const container = buildLicenseContainer(item.envelope, item.controlEnvelope)
      deps.files.writeAtomic(item.license.fileName, container)
      writtenFiles.push(item.license.fileName)
    }
  } catch (error) {
    for (const fileName of writtenFiles) {
      try {
        deps.files.remove(fileName)
      } catch {
        // 补偿失败不掩盖原始错误，遗留文件由 reconcile 处理
      }
    }
    withTransaction(deps.database, () => {
      for (const item of prepared) {
        deleteLicense(deps.database, item.license.licenseId)
      }
    })
    auditFailure(deps, action, 'license', prepared[0]?.license.licenseId ?? 'unknown', 'license_file_error', null)
    if (error instanceof ServiceError) {
      throw error
    }
    throw new ServiceError('license_file_error', `写入授权文件失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  const result: LicenseDto[] = []
  try {
    withTransaction(deps.database, () => {
    for (const item of prepared) {
      markLicenseFileState(deps.database, item.license.licenseId, 'written')
      if (item.supersedes !== null && item.supersedes !== item.license.licenseId) {
        setSupersededBy(deps.database, item.supersedes, item.license.licenseId)
      }
      result.push({ ...item.license, fileState: 'written' })
      writeAudit(deps, {
        at,
        action,
        targetType: 'license',
        targetId: item.license.licenseId,
        result: 'success',
        errorCode: null,
        context: JSON.stringify({
          projectId: item.license.projectId,
          deviceId: item.license.deviceId,
          expiresAt: item.license.expiresAt,
          controlLicenseId: item.license.controlLicenseId
        })
      })
    }
    if (prepared.length > 1) {
      writeAudit(deps, {
        at,
        action: `${action}_summary`,
        targetType: 'license-batch',
        targetId: prepared[0]?.license.licenseId ?? 'unknown',
        result: 'success',
        errorCode: null,
        context: JSON.stringify({ count: prepared.length })
      })
    }
    // 证书可重复使用（2026-10-24 决策）：签发/续期不再消费证书。
    // 证书仍由有效期、项目范围与 max_devices 约束；过期/验证失败在 loadVerifiedControlCertificate 处拒绝。
    })
  } catch (error) {
    // 数据库提交失败：文件已经落盘，按相反顺序补偿，避免出现"有文件没记录"的授权
    for (const fileName of writtenFiles) {
      try {
        deps.files.remove(fileName)
      } catch {
        // 交由 reconcile 兜底
      }
    }
    try {
      withTransaction(deps.database, () => {
        for (const item of prepared) {
          deleteLicense(deps.database, item.license.licenseId)
        }
      })
    } catch {
      // 回滚失败时保留 pending 记录，下次启动由 reconcile 清理
    }
    auditFailure(deps, action, 'license', prepared[0]?.license.licenseId ?? 'unknown', errorCodeOf(error), null)
    throw error
  }
  return result
}

/**
 * 中断恢复：
 * - pending 记录说明签发过程在写文件前后被打断，对应文件不可作为有效授权，回滚并记录；
 * - 目录里没有数据库记录的文件移入隔离目录，避免被误当成合法授权分发。
 */
export function reconcileLicenseStorage(deps: ResolvedDependencies): ReconcileResultDto {
  const at = formatTimestamp(deps.now())
  let pendingRolledBack = 0
  for (const license of listPendingLicenses(deps.database)) {
    if (deps.files.exists(license.fileName)) {
      deps.files.remove(license.fileName)
    }
    withTransaction(deps.database, () => {
      deleteLicense(deps.database, license.licenseId)
      writeAudit(deps, {
        at,
        action: 'license_reconcile',
        targetType: 'license',
        targetId: license.licenseId,
        result: 'failure',
        errorCode: 'interrupted_issuance',
        context: JSON.stringify({ projectId: license.projectId, deviceId: license.deviceId })
      })
    })
    pendingRolledBack += 1
  }

  const known = new Set(listAllLicenseFileNames(deps.database))
  let orphanFilesQuarantined = 0
  for (const fileName of deps.files.list()) {
    if (known.has(fileName)) {
      continue
    }
    if (deps.files.quarantine(fileName)) {
      orphanFilesQuarantined += 1
      writeAudit(deps, {
        at,
        action: 'license_orphan_quarantine',
        targetType: 'license-file',
        targetId: fileName,
        result: 'failure',
        errorCode: 'orphan_file',
        context: null
      })
    }
  }

  return { pendingRolledBack, orphanFilesQuarantined }
}

function requireDelegatedKey(
  deps: ResolvedDependencies,
  certificate: VerifiedControlCertificate,
  action: string
): KeyObject {
  const delegated = deps.delegatedKeys.load()
  if (delegated === null) {
    auditFailure(deps, action, 'control-certificate', certificate.payload.license_id, 'delegated_key_missing', null)
    throw new ServiceError('delegated_key_missing', '本机没有委托签发私钥，无法签发')
  }
  if (!samePublicKey(delegated.publicParams, certificate.verified.delegatedPublicKeyParams)) {
    auditFailure(deps, action, 'control-certificate', certificate.payload.license_id, 'delegated_key_mismatch', null)
    throw new ServiceError('delegated_key_mismatch', '本机委托私钥与中控证书不匹配')
  }
  return delegated.privateKey
}

/**
 * 服务默认有效期（90 天，且不超过中控证书到期）。
 * 手工签发与局域网下发必须共用同一规则，不能在网络层另写一套。
 */
export function resolveDefaultExpiry(deps: ResolvedDependencies): string {
  const certificate = loadVerifiedControlCertificate(deps)
  return resolveExpiry(undefined, deps.now().getTime(), parseTimestamp(certificate.payload.expires_at))
}

function resolveExpiry(requested: string | undefined, nowMs: number, controlExpiresAt: number): string {
  const controlLatest = controlExpiresAt
  if (requested === undefined) {
    const preferred = Math.min(nowMs + DEFAULT_VALIDITY_DAYS * DAY_MS, controlLatest)
    return formatTimestamp(new Date(preferred))
  }
  let expiresMs: number
  try {
    expiresMs = parseTimestamp(requested)
  } catch (error) {
    throw new ServiceError('invalid_argument', `到期时间不合法: ${error instanceof Error ? error.message : ''}`)
  }
  if (expiresMs <= nowMs) {
    throw new ServiceError('license_expiry_invalid', '到期时间必须晚于当前时间')
  }
  if (expiresMs > controlLatest) {
    throw new ServiceError(
      'license_expiry_invalid',
      `子机授权到期时间不得晚于中控证书到期时间（上限 ${formatTimestamp(new Date(controlLatest))}）`,
      { maxExpiresAt: formatTimestamp(new Date(controlLatest)) }
    )
  }
  return formatTimestamp(new Date(expiresMs))
}

function generateLicenseId(now: Date): string {
  const stamp = formatTimestamp(now).replace(/[-:TZ]/g, '').slice(0, 14)
  return `MCH-${stamp}-${randomBytes(3).toString('hex').toUpperCase()}`
}

function auditFailure(
  deps: ResolvedDependencies,
  action: string,
  targetType: string,
  targetId: string,
  errorCode: string,
  context: string | null
): void {
  writeAudit(deps, {
    at: formatTimestamp(deps.now()),
    action,
    targetType,
    targetId,
    result: 'failure',
    errorCode,
    context
  })
}

function errorCodeOf(error: unknown): string {
  if (error instanceof ServiceError) {
    return error.code
  }
  if (isLicenseError(error)) {
    return error.code
  }
  return 'unexpected'
}
