// @vitest-environment node
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { createServer, createConnection, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { HubServer, type HubServerOptions } from '../../src/main/hub/hub-server'
import type { PullResultDto } from '@shared/license/hub-contract'

const servers: HubServer[] = []
const udpClients: UdpSocket[] = []
const blockers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop()
  }
  for (const client of udpClients.splice(0)) {
    client.close()
  }
  for (const blocker of blockers.splice(0)) {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  }
})

async function startServer(overrides: Partial<HubServerOptions> = {}): Promise<{
  server: HubServer
  status: ReturnType<HubServer['status']>
  requests: Array<{ deviceId: string; ip: string | null }>
}> {
  const requests: Array<{ deviceId: string; ip: string | null }> = []
  const server = new HubServer({
    udpPort: 0,
    tcpPort: 0,
    listenAddress: '127.0.0.1',
    deviceCooldownMs: 0,
    clientSchemaSupported: false,
    clientSchemaReason: '插件 v1 / 中控 v3',
    handlePull: (request) => {
      requests.push({ deviceId: request.deviceId, ip: request.ip })
      return {
        status: 'issued',
        license: '{"v":1,"license":"L","control":"C"}',
        reason: '',
        orderId: 'ord-1'
      } satisfies PullResultDto
    },
    ...overrides
  })
  servers.push(server)
  const status = await server.start()
  return { server, status, requests }
}

function discover(udpPort: number, packet: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createSocket('udp4')
    udpClients.push(client)
    const timer = setTimeout(() => reject(new Error('UDP 超时')), 3000)
    client.once('message', (message) => {
      clearTimeout(timer)
      resolve(message.toString('utf8'))
    })
    client.bind(0, '127.0.0.1', () => {
      client.send(Buffer.from(packet, 'utf8'), udpPort, '127.0.0.1')
    })
  })
}

function pull(port: number, line: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let data = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('TCP 超时'))
    }, 3000)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      data += chunk
    })
    socket.on('end', () => {
      clearTimeout(timer)
      resolve(data)
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.write(line)
  })
}

function requestLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    v: 1,
    device_id: 'dev-1',
    project_id: 'proj-a',
    current_license_id: '',
    last_expires_at: null,
    nonce: 'nonce-1',
    ...overrides
  })}\n`
}

describe('Hub 生命周期', () => {
  it('启动后报告真实监听地址与端口', async () => {
    const { status } = await startServer()
    expect(status.state).toBe('running')
    expect(status.listenAddress).toBe('127.0.0.1')
    expect(status.tcpPort).toBeGreaterThan(0)
    expect(status.udpPort).toBeGreaterThan(0)
    expect(status.error).toBeNull()
  })

  it('重复启动不会新建监听，状态保持 running', async () => {
    const { server, status } = await startServer()
    const again = await server.start()
    expect(again.state).toBe('running')
    expect(again.tcpPort).toBe(status.tcpPort)
  })

  it('端口被占用时启动失败并保留真实错误，不会显示为已启动', async () => {
    const blocker = createServer()
    blockers.push(blocker)
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()))
    const address = blocker.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    const server = new HubServer({
      udpPort: 0,
      tcpPort: port,
      listenAddress: '127.0.0.1',
      clientSchemaSupported: false,
      clientSchemaReason: null,
      handlePull: () => ({ status: 'denied', license: '', reason: 'x', orderId: null })
    })
    servers.push(server)
    await expect(server.start()).rejects.toThrow()
    expect(server.status().state).toBe('error')
    expect(server.status().error).not.toBeNull()
  })

  it('停止后释放端口，重新启动可以成功', async () => {
    const first = await startServer()
    const port = first.status.tcpPort
    await first.server.stop()
    expect(first.server.status().state).toBe('stopped')

    const second = await startServer({ tcpPort: port })
    expect(second.status.state).toBe('running')
    expect(second.status.tcpPort).toBe(port)
  })

  it('停止后不再接受连接', async () => {
    const { server, status } = await startServer()
    await server.stop()
    await expect(pull(status.tcpPort, requestLine())).rejects.toThrow()
  })
})

describe('UDP 发现', () => {
  it('对插件的发现包回 AEGIS-HERE，并给出真实 TCP 端口', async () => {
    const { status } = await startServer()
    const response = await discover(status.udpPort, 'AEGIS-DISCOVER/1 dev-1 proj-a')
    expect(response).toBe(`AEGIS-HERE/1 127.0.0.1 ${status.tcpPort}`)
  })

  it('畸形发现包不回应（不泄漏服务存在）', async () => {
    const { status } = await startServer()
    await expect(discover(status.udpPort, 'HELLO/1 dev-1 proj-a')).rejects.toThrow()
  })
})

describe('TCP 拉取', () => {
  it('正常请求返回五个键的响应并回显 nonce', async () => {
    const { status, requests } = await startServer()
    const response = await pull(status.tcpPort, requestLine())
    const parsed = JSON.parse(response.trim()) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['license', 'nonce', 'reason', 'status', 'v'])
    expect(parsed['status']).toBe('issued')
    expect(parsed['nonce']).toBe('nonce-1')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.deviceId).toBe('dev-1')
    expect(requests[0]?.ip).toBe('127.0.0.1')
  })

  it('畸形 JSON 返回 denied 且不调用业务层', async () => {
    const { status, requests } = await startServer()
    const response = await pull(status.tcpPort, '{oops\n')
    const parsed = JSON.parse(response.trim()) as Record<string, unknown>
    expect(parsed['status']).toBe('denied')
    expect(parsed['reason']).toBe('request_malformed')
    expect(requests).toHaveLength(0)
  })

  it('超出请求上限时拒绝并关闭连接', async () => {
    const { status } = await startServer()
    const response = await pull(status.tcpPort, Buffer.alloc(5000, 0x41))
    const parsed = JSON.parse(response.trim()) as Record<string, unknown>
    expect(parsed['status']).toBe('denied')
    expect(parsed['reason']).toBe('request_too_large')
  })

  it('单设备频率限制生效', async () => {
    const { status } = await startServer({ deviceCooldownMs: 60_000 })
    const first = await pull(status.tcpPort, requestLine())
    expect((JSON.parse(first.trim()) as Record<string, unknown>)['status']).toBe('issued')
    const second = await pull(status.tcpPort, requestLine())
    const parsed = JSON.parse(second.trim()) as Record<string, unknown>
    expect(parsed['status']).toBe('denied')
    expect(parsed['reason']).toBe('rate_limited')
  })

  it('业务层异常不会泄露堆栈，返回 denied server_error', async () => {
    const { status } = await startServer({
      handlePull: () => {
        throw new Error('内部堆栈不应出现在响应里')
      }
    })
    const response = await pull(status.tcpPort, requestLine())
    const parsed = JSON.parse(response.trim()) as Record<string, unknown>
    expect(parsed['status']).toBe('denied')
    expect(parsed['reason']).toBe('server_error')
    expect(response).not.toContain('内部堆栈')
  })
})
