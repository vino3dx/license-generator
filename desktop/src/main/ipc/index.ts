import { registerAppIpc } from './app'
import { registerLicenseIpc } from './license'

/**
 * IPC 注册总入口。
 * 通道集中注册，便于审计"渲染进程能调用什么"。
 */
export function registerIpcHandlers(): void {
  registerAppIpc()
  registerLicenseIpc()
}
