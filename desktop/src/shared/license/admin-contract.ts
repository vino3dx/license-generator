/**
 * 管理员认证的跨进程契约。
 *
 * 边界：
 * - 口令只在主进程参与校验，渲染进程既不保存哈希也无法绕过；
 * - 所有敏感操作在主进程逐个校验会话状态（未解锁 → admin_locked）；
 * - 本机管理员口令只防"现场误操作/非授权人员使用本机界面"，
 *   不能防御能读取该 Windows 用户文件与内存的攻击者（文档与 UI 必须如实说明）。
 */

export const ADMIN_IPC_CHANNELS = {
  adminStatus: 'admin:status',
  adminSetup: 'admin:setup',
  adminUnlock: 'admin:unlock',
  adminLock: 'admin:lock',
  adminChangePassword: 'admin:change-password'
} as const

export type AdminIpcChannel = (typeof ADMIN_IPC_CHANNELS)[keyof typeof ADMIN_IPC_CHANNELS]

export interface AdminStatusDto {
  /** 是否已经设置过管理员口令 */
  readonly credentialConfigured: boolean
  /** 当前是否处于解锁会话中（已通过主进程校验且未超时） */
  readonly unlocked: boolean
  /** 当前会话剩余空闲时间（毫秒）；未解锁为 0 */
  readonly idleRemainingMs: number
  /** 会话空闲超时阈值（毫秒），由主进程决定 */
  readonly idleTimeoutMs: number
  /** 失败次数达到上限后的锁定到期时间（ISO 时间）；未锁定为 null */
  readonly lockedOutUntil: string | null
  /** 解除锁定前还可尝试的次数 */
  readonly remainingAttempts: number
}

/** 设置口令时的最小长度（主进程强制，界面提示只是辅助） */
export const ADMIN_PASSWORD_MIN_LENGTH = 10
