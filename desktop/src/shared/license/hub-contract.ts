/**
 * 本地 Hub（局域网授权下发）的跨进程契约。
 *
 * 协议来源（以实际代码为准，不按文档猜测）：
 * - `godot/addons/aegis/aegis_net.gd`：
 *   UDP 47820 收 `AEGIS-DISCOVER/1 <device_id> <project_id>`，回应 `AEGIS-HERE/1 <host> <port>`；
 *   TCP 47821 收一行 JSON 请求，回一行 JSON 响应，键集合固定为 v/status/license/reason/nonce。
 * - `godot/addons/aegis/aegis_rsa_verify.gd:20`：插件只接受 `schema_version = 1`。
 */

export const HUB_UDP_PORT = 47820
export const HUB_TCP_PORT = 47821
export const HUB_DISCOVER_PREFIX = 'AEGIS-DISCOVER/1 '
export const HUB_HERE_PREFIX = 'AEGIS-HERE/1 '
export const HUB_REQUEST_MAX_BYTES = 4096
export const HUB_RESPONSE_MAX_BYTES = 16384
export const HUB_DISCOVER_MAX_BYTES = 256

/**
 * 仓库内 Godot 插件验签器接受的协议版本。
 * 依据：`godot/addons/aegis/aegis_rsa_verify.gd` 的 `SCHEMA_VERSION := 1`。
 * 中控当前签发 v3，两者不一致时 Hub 不会下发授权（避免让现场误以为已派发）。
 */
export const GODOT_PLUGIN_SCHEMA_VERSION = 1

export const HUB_IPC_CHANNELS = {
  hubStatus: 'hub:status',
  hubStart: 'hub:start',
  hubStop: 'hub:stop',
  hubRequests: 'hub:requests'
} as const

export type HubIpcChannel = (typeof HUB_IPC_CHANNELS)[keyof typeof HUB_IPC_CHANNELS]

export type HubState = 'stopped' | 'starting' | 'running' | 'error'

export interface HubStatusDto {
  readonly state: HubState
  /** 实际监听地址（0.0.0.0 表示所有网卡，界面必须提示暴露范围） */
  readonly listenAddress: string
  /** 发现应答里回给客户端的地址（0.0.0.0 时不可用，会回环或首个局域网地址） */
  readonly advertiseAddress: string | null
  readonly udpPort: number
  readonly tcpPort: number
  readonly startedAt: string | null
  readonly error: string | null
  /** 中控签发格式是否与已知插件期望一致；false 时 Hub 只会拒绝，不会下发 */
  readonly clientSchemaSupported: boolean
  readonly clientSchemaReason: string | null
  readonly activeConnections: number
  readonly totalRequests: number
}

/** 一次拉取请求的服务端判定结果（Hub 状态之外，用 device_requests 表留证） */
export interface PullResultDto {
  readonly status: 'issued' | 'unchanged' | 'denied'
  /** 授权容器文本；denied 时为空串 */
  readonly license: string
  /** 稳定原因码，客户端不需要解析，供中控 UI/审计使用 */
  readonly reason: string
  readonly orderId: string | null
}
