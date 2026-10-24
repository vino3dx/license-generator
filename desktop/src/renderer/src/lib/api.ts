import type { IpcResult, ServiceErrorPayload } from '@shared/license/service-contract'

/** 业务错误：保留错误码，界面按码给出可诊断提示 */
export class ApiError extends Error {
  constructor(readonly payload: ServiceErrorPayload) {
    super(payload.message)
    this.name = 'ApiError'
  }

  get code(): string {
    return this.payload.code
  }
}

export function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) {
    return result.value
  }
  throw new ApiError(result.error)
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.payload.message}（${error.payload.code}）`
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export function errorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.payload.code : null
}

/** 只在调用时读取 window，避免模块加载阶段依赖渲染环境 */
export function licenseApi(): Window['aegis']['license'] {
  if (typeof window === 'undefined' || window.aegis === undefined) {
    throw new Error('Aegis 接口不可用：请通过 Electron 客户端运行')
  }
  return window.aegis.license
}

export function appApi(): Window['aegis'] {
  if (typeof window === 'undefined' || window.aegis === undefined) {
    throw new Error('Aegis 接口不可用：请通过 Electron 客户端运行')
  }
  return window.aegis
}

/** 管理员会话 API；解锁状态由主进程持有，这里只是通道 */
export function adminApi(): Window['aegis']['admin'] {
  if (typeof window === 'undefined' || window.aegis === undefined) {
    throw new Error('Aegis 接口不可用：请通过 Electron 客户端运行')
  }
  return window.aegis.admin
}

/** 本地 Hub API；启停由主进程执行，渲染进程不接触 socket */
export function hubApi(): Window['aegis']['hub'] {
  if (typeof window === 'undefined' || window.aegis === undefined) {
    throw new Error('Aegis 接口不可用：请通过 Electron 客户端运行')
  }
  return window.aegis.hub
}
