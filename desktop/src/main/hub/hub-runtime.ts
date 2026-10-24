import type { HubStatusDto } from '@shared/license/hub-contract'
import { getLicenseRuntime } from '../license-runtime'
import { HubServer } from './hub-server'

/**
 * Hub 单例：随主进程存活，启动/停止由 IPC 控制。
 * 网络端口固定为协议规定的 47820/47821；绑定失败时状态为 error 并保留真实原因。
 */
let server: HubServer | null = null

export function getHubServer(): HubServer {
  if (server !== null) {
    return server
  }
  const services = getLicenseRuntime().services
  const schema = services.hub.clientSchema()
  server = new HubServer({
    clientSchemaSupported: schema.supported,
    clientSchemaReason: schema.reason,
    handlePull: (request) => services.hub.handlePull(request)
  })
  return server
}

export function getHubStatus(): HubStatusDto {
  return getHubServer().status()
}

/** 进程退出：同步释放 socket，避免残留监听 */
export function disposeHub(): void {
  if (server !== null) {
    server.dispose()
    server = null
  }
}
