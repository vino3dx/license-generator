import { registerAdminIpc } from './admin'
import { registerAppIpc } from './app'
import { registerHubIpc } from './hub'
import { registerLicenseIpc } from './license'

/**
 * IPC 注册总入口。
 * 通道集中注册，便于审计"渲染进程能调用什么"。
 * 敏感通道的管理员会话校验在各自的注册函数内完成（见 ipc/license.ts 的 SENSITIVE_CHANNELS
 * 与 ipc/hub.ts 的 sensitive 标记）。
 */
export function registerIpcHandlers(): void {
  registerAppIpc()
  registerAdminIpc()
  registerLicenseIpc()
  registerHubIpc()
}
