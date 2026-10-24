import { createSocket, type RemoteInfo, type Socket as UdpSocket } from 'node:dgram'
import { createServer, type Server, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import {
  HUB_DISCOVER_MAX_BYTES,
  HUB_REQUEST_MAX_BYTES,
  HUB_TCP_PORT,
  HUB_UDP_PORT,
  type HubState,
  type HubStatusDto,
  type PullResultDto
} from '@shared/license/hub-contract'
import {
  buildDiscoverResponse,
  buildPullResponse,
  isLoopbackAddress,
  parseDiscoverPacket,
  parsePullRequest,
  type PullRequestInput
} from '@core/services/hub-protocol'

/**
 * 本地 Hub：UDP 47820 发现应答 + TCP 47821 拉取服务。
 *
 * 边界：
 * - 只做主进程网络 I/O，授权决策全部交给 core/services（不在这里签名或放宽校验）；
 * - 每次请求都重新走业务层校验（设备登记、证书范围、额度、幂等订单）；
 * - 请求长度/读取时间/并发连接/单设备频率都有限制，避免被慢连接或畸形包拖死；
 * - 停止时关闭 UDP/TCP 与所有活动连接，不残留句柄。
 */

export interface HubServerOptions {
  readonly udpPort?: number
  readonly tcpPort?: number
  /** 监听地址；默认 0.0.0.0（所有网卡），界面必须提示暴露范围 */
  readonly listenAddress?: string
  /** 发现应答里回给客户端的地址；null 表示自动选择 */
  readonly advertiseAddress?: string | null
  readonly readTimeoutMs?: number
  readonly maxConnections?: number
  readonly deviceCooldownMs?: number
  readonly clientSchemaSupported: boolean
  readonly clientSchemaReason: string | null
  readonly handlePull: (request: PullRequestInput & { readonly ip: string | null }) => PullResultDto
  readonly now?: () => Date
}

const DEFAULT_READ_TIMEOUT_MS = 2000
const DEFAULT_MAX_CONNECTIONS = 8
const DEFAULT_DEVICE_COOLDOWN_MS = 1000

export class HubServer {
  private readonly options: HubServerOptions
  private udp: UdpSocket | null = null
  private tcp: Server | null = null
  private readonly connections = new Set<Socket>()
  private readonly lastRequestAt = new Map<string, number>()
  private state: HubState = 'stopped'
  private error: string | null = null
  private startedAt: string | null = null
  private actualUdpPort = 0
  private actualTcpPort = 0
  private totalRequests = 0

  constructor(options: HubServerOptions) {
    this.options = options
  }

  async start(): Promise<HubStatusDto> {
    if (this.state === 'running' || this.state === 'starting') {
      return this.status()
    }
    this.state = 'starting'
    this.error = null
    try {
      await this.startTcp()
      await this.startUdp()
      this.state = 'running'
      this.startedAt = (this.options.now ?? (() => new Date()))().toISOString()
      return this.status()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await this.stopSockets()
      this.state = 'error'
      this.error = message
      throw new Error(`Hub 启动失败：${message}`)
    }
  }

  async stop(): Promise<HubStatusDto> {
    await this.stopSockets()
    this.state = 'stopped'
    this.startedAt = null
    this.lastRequestAt.clear()
    return this.status()
  }

  /** 进程退出时同步释放（不等待回调） */
  dispose(): void {
    for (const socket of this.connections) {
      socket.destroy()
    }
    this.connections.clear()
    try {
      this.udp?.close()
    } catch {
      // 已关闭
    }
    this.udp = null
    try {
      this.tcp?.close()
    } catch {
      // 已关闭
    }
    this.tcp = null
    this.state = 'stopped'
  }

  status(): HubStatusDto {
    return {
      state: this.state,
      listenAddress: this.options.listenAddress ?? '0.0.0.0',
      advertiseAddress: this.resolveAdvertiseAddress(),
      udpPort: this.actualUdpPort > 0 ? this.actualUdpPort : (this.options.udpPort ?? HUB_UDP_PORT),
      tcpPort: this.actualTcpPort > 0 ? this.actualTcpPort : (this.options.tcpPort ?? HUB_TCP_PORT),
      startedAt: this.startedAt,
      error: this.error,
      clientSchemaSupported: this.options.clientSchemaSupported,
      clientSchemaReason: this.options.clientSchemaReason,
      activeConnections: this.connections.size,
      totalRequests: this.totalRequests
    }
  }

  private async startTcp(): Promise<void> {
    const server = createServer((socket) => this.handleConnection(socket))
    server.on('error', (error) => {
      this.error = error.message
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.tcpPort ?? HUB_TCP_PORT, this.options.listenAddress ?? '0.0.0.0')
    })
    const address = server.address()
    this.actualTcpPort = typeof address === 'object' && address !== null ? address.port : (this.options.tcpPort ?? HUB_TCP_PORT)
    this.tcp = server
  }

  private async startUdp(): Promise<void> {
    const socket = createSocket('udp4')
    socket.on('error', (error) => {
      this.error = error.message
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        socket.removeListener('error', onError)
        resolve()
      }
      socket.once('error', onError)
      socket.once('listening', onListening)
      socket.bind(this.options.udpPort ?? HUB_UDP_PORT, this.options.listenAddress ?? '0.0.0.0')
    })
    socket.on('message', (message: Buffer, info: RemoteInfo) => this.handleDiscover(socket, message, info))
    const address = socket.address()
    this.actualUdpPort = address.port
    this.udp = socket
  }

  private handleDiscover(socket: UdpSocket, message: Buffer, info: RemoteInfo): void {
    if (message.length === 0 || message.length > HUB_DISCOVER_MAX_BYTES) {
      return
    }
    const parsed = parseDiscoverPacket(message)
    if (!parsed.ok) {
      return
    }
    const host = isLoopbackAddress(info.address)
      ? '127.0.0.1'
      : (this.resolveAdvertiseAddress() ?? '127.0.0.1')
    const response = buildDiscoverResponse(host, this.actualTcpPort)
    try {
      socket.send(response, info.port, info.address)
    } catch {
      // 单个应答失败不影响服务
    }
  }

  private handleConnection(socket: Socket): void {
    const max = this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS
    if (this.connections.size >= max) {
      socket.destroy()
      return
    }
    this.connections.add(socket)
    const ip = normIp(socket.remoteAddress)
    let buffer = Buffer.alloc(0)
    let settled = false

    const finish = (): void => {
      settled = true
      this.connections.delete(socket)
      clearTimeout(timer)
    }

    const timer = setTimeout(() => {
      if (!settled) {
        socket.destroy()
        finish()
      }
    }, this.options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS)

    socket.on('error', () => {
      finish()
      socket.destroy()
    })
    socket.on('close', () => {
      finish()
    })
    socket.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > HUB_REQUEST_MAX_BYTES + 1) {
        settled = true
        this.respond(socket, { status: 'denied', license: '', reason: 'request_too_large', orderId: null }, '', ip)
        return
      }
      const index = buffer.indexOf(10)
      if (index < 0) {
        return
      }
      settled = true
      const line = buffer.subarray(0, index)
      this.handleLine(socket, line, ip)
    })
  }

  private handleLine(socket: Socket, line: Buffer, ip: string | null): void {
    const parsed = parsePullRequest(line)
    if (!parsed.ok) {
      this.respond(socket, { status: 'denied', license: '', reason: parsed.reason, orderId: null }, '', ip)
      return
    }
    const request = parsed.value
    const cooldown = this.options.deviceCooldownMs ?? DEFAULT_DEVICE_COOLDOWN_MS
    const nowMs = (this.options.now ?? (() => new Date()))().getTime()
    const last = this.lastRequestAt.get(request.deviceId) ?? 0
    if (cooldown > 0 && nowMs - last < cooldown) {
      this.respond(socket, { status: 'denied', license: '', reason: 'rate_limited', orderId: null }, request.nonce, ip)
      return
    }
    this.lastRequestAt.set(request.deviceId, nowMs)
    this.totalRequests += 1

    let result: PullResultDto
    try {
      result = this.options.handlePull({ ...request, ip })
    } catch (error) {
      result = {
        status: 'denied',
        license: '',
        reason: error instanceof Error ? 'server_error' : 'server_error',
        orderId: null
      }
    }
    this.respond(socket, result, request.nonce, ip)
  }

  private respond(socket: Socket, result: PullResultDto, nonce: string, _ip: string | null): void {
    const text = buildPullResponse({
      status: result.status,
      license: result.license,
      reason: result.reason,
      nonce
    })
    try {
      socket.end(`${text}\n`)
    } catch {
      socket.destroy()
    }
  }

  private resolveAdvertiseAddress(): string | null {
    if (this.options.advertiseAddress !== undefined && this.options.advertiseAddress !== null) {
      return this.options.advertiseAddress
    }
    const listen = this.options.listenAddress ?? '0.0.0.0'
    if (listen !== '0.0.0.0' && listen !== '::') {
      return listen
    }
    const interfaces = networkInterfaces()
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          return entry.address
        }
      }
    }
    return '127.0.0.1'
  }

  private async stopSockets(): Promise<void> {
    for (const socket of this.connections) {
      socket.destroy()
    }
    this.connections.clear()
    if (this.udp !== null) {
      const socket = this.udp
      this.udp = null
      await new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
    if (this.tcp !== null) {
      const server = this.tcp
      this.tcp = null
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
  }
}

function normIp(address: string | undefined): string | null {
  if (address === undefined) {
    return null
  }
  return address.startsWith('::ffff:') ? address.slice(7) : address
}
