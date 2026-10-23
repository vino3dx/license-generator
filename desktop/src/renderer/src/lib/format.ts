/** 时间、状态与错误码的展示规则；只做格式化，不做业务判断 */

const DATE_TIME = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

/** 协议时间是 UTC `YYYY-MM-DDTHH:MM:SSZ`，界面统一显示本地时间 */
export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) {
    return '—'
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return value
  }
  return DATE_TIME.format(new Date(parsed))
}

export function formatDate(value: string | null | undefined): string {
  const text = formatDateTime(value)
  return text === '—' ? text : text.slice(0, 10)
}

/** 距到期的整天数；已过期返回负数 */
export function daysUntil(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value === null || value === undefined || value.length === 0) {
    return null
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return Math.ceil((parsed - now) / 86_400_000)
}

/** `<input type="datetime-local">` 的本地时间 → 协议要求的 UTC 秒级时间 */
export function localInputToUtc(value: string): string | null {
  if (value.trim().length === 0) {
    return null
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return `${new Date(parsed).toISOString().slice(0, 19)}Z`
}

export const PROJECT_STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  archived: '已归档'
}

export const LICENSE_STATUS_LABEL: Record<string, string> = {
  active: '有效',
  revoked: '已吊销'
}

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  project_create: '创建项目',
  project_update: '编辑项目',
  device_register: '登记设备',
  device_unbind: '解绑设备',
  device_lock: '锁定设备',
  device_unlock: '解锁设备',
  control_certificate_import: '导入中控证书',
  control_certificate_consume: '证书作废（一次性）',
  delegated_key_import: '导入委托私钥',
  license_issue: '签发授权',
  license_batch_issue: '批量签发',
  license_renew: '续期授权',
  license_reconcile: '授权文件对账'
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] ?? action
}

const FILE_CHECK_LABEL: Record<string, string> = {
  no_license: '尚未签发',
  file_missing: '授权文件缺失',
  file_hash_mismatch: '文件与记录不一致',
  signature_invalid: '签名无效',
  expired: '已过期',
  not_yet_valid: '尚未生效',
  device_mismatch: '设备不匹配',
  project_not_allowed: '项目不匹配',
  status_inactive: '授权已吊销',
  control_license_mismatch: '中控证书不匹配'
}

export function fileCheckLabel(code: string | null): string {
  if (code === null) {
    return '文件校验通过'
  }
  return FILE_CHECK_LABEL[code] ?? `校验失败（${code}）`
}

export function fileCheckOk(code: string | null): boolean {
  return code === null
}
