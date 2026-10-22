import type { ServiceErrorCode, ServiceErrorPayload } from '@shared/license/service-contract'

/** 业务层错误：只对上层暴露稳定 code，渲染进程不需要解析 message */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode
  readonly details: Record<string, string | number | boolean>

  constructor(
    code: ServiceErrorCode,
    message: string,
    details: Record<string, string | number | boolean> = {}
  ) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    this.details = details
  }
}

export function isServiceError(value: unknown): value is ServiceError {
  return value instanceof ServiceError
}

export function toServiceErrorPayload(error: unknown): ServiceErrorPayload {
  if (isServiceError(error)) {
    return { code: error.code, message: error.message, details: error.details }
  }
  return { code: 'unexpected', message: error instanceof Error ? error.message : String(error) }
}

export function assertIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new ServiceError('invalid_argument', `${field} 不合法`)
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value) || value.includes('..')) {
    throw new ServiceError('invalid_argument', `${field} 只能包含字母数字与 . _ : -，且不能含 ..`)
  }
  return value
}
