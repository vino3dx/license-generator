#!/usr/bin/env node
// Electron 端到端冒烟：启动真实客户端，通过 CDP 在渲染进程里调用 preload API，
// 验证「渲染进程 → preload → IPC → 业务服务 → SQLite」整条链路。
//
// 使用临时 userData 目录，不污染开发数据库；退出时删除临时目录。
// 用法：npm run build && node scripts/electron-smoke.mjs
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronBin = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(electronBin)) {
  console.error(`找不到 Electron 可执行文件: ${electronBin}`)
  process.exit(2)
}

const port = 9223
const tempUserData = mkdtempSync(join(tmpdir(), 'aegis-smoke-'))
// 当前环境可能设置了 ELECTRON_RUN_AS_NODE=1，会把 Electron 当 Node 运行，必须移除
const env = { ...process.env }
delete env['ELECTRON_RUN_AS_NODE']
const child = spawn(electronBin, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${tempUserData}`], {
  cwd: process.cwd(),
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})

let logs = ''
child.stdout.on('data', (chunk) => {
  logs += String(chunk)
})
child.stderr.on('data', (chunk) => {
  logs += String(chunk)
})

const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForPage() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await response.json()
      const page = targets.find(
        (target) =>
          target.type === 'page' &&
          typeof target.url === 'string' &&
          target.url.includes('index.html') &&
          target.webSocketDebuggerUrl
      )
      if (page !== undefined) {
        return page
      }
    } catch {
      // 还没起来
    }
    await timeout(250)
  }
  throw new Error(`CDP 未就绪：\n${logs}`)
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('CDP 求值超时'))
    }, 20_000)
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 1) {
        return
      }
      clearTimeout(timer)
      socket.close()
      if (message.error !== undefined) {
        reject(new Error(JSON.stringify(message.error)))
        return
      }
      resolve(message.result)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP 连接失败'))
    })
  })
}

function buildExpression(expectedUserData) {
  return `(async () => {
  const waitFor = async (predicate, ms = 10000) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  }
  const navReady = await waitFor(() => {
    const nav = document.querySelector('.sidebar__nav')
    return nav !== null && nav.children.length === 4
  })
  const app = window.aegis
  const license = app.license
  const info = await app.getAppInfo()
  const isolated = info.userDataPath === ${JSON.stringify(expectedUserData)}

  const [projects, vendor, audit, control] = await Promise.all([
    license.listProjects(),
    license.vendorKeyStatus(),
    license.listAuditLogs({ limit: 5 }),
    license.currentControlCertificate()
  ])

  // 只在隔离目录里做真实写入，避免污染开发数据库
  let created = null
  let afterCreate = null
  let duplicate = null
  let createAudit = null
  if (isolated) {
    const smokeId = 'SMOKE-' + Date.now()
    created = await license.createProject({ projectId: smokeId, name: '冒烟测试项目' })
    afterCreate = await license.listProjects()
    duplicate = await license.createProject({ projectId: smokeId, name: '重复项目' })
    createAudit = await license.listAuditLogs({ action: 'project_create', limit: 20 })
    created = { ...created, smokeId }
  }

  const nav = document.querySelector('.sidebar__nav')
  return JSON.stringify({
    hasApi: typeof license.listProjects === 'function',
    navReady,
    navCount: nav === null ? 0 : nav.children.length,
    hasProjectPage: document.body.innerText.includes('项目管理'),
    userDataPath: info.userDataPath,
    isolated,
    projectsOk: projects.ok,
    vendorOk: vendor.ok,
    vendorConfigured: vendor.ok ? vendor.value.configured : null,
    auditOk: audit.ok,
    controlOk: control.ok,
    controlValue: control.ok ? control.value : 'error',
    createdOk: created === null ? null : created.ok,
    createdId: created === null || !created.ok ? null : created.smokeId,
    listRefreshed:
      created === null || !created.ok || afterCreate === null || !afterCreate.ok
        ? null
        : afterCreate.value.some((item) => item.projectId === created.smokeId),
    duplicateRejected:
      duplicate === null ? null : duplicate.ok === false && duplicate.error.code === 'conflict',
    auditRecorded:
      created === null || !created.ok || createAudit === null || !createAudit.ok
        ? null
        : createAudit.value.some((item) => item.targetId === created.smokeId && item.result === 'success')
  })
})()`
}

let exitCode = 0
try {
  const expression = buildExpression(tempUserData)
  let result = null
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const page = await waitForPage()
    try {
      result = await evaluate(page.webSocketDebuggerUrl, expression)
      break
    } catch (error) {
      lastError = error
      // 窗口首次导航会销毁旧执行上下文，稍后重试即可
      await timeout(800)
    }
  }
  if (result === null) {
    throw lastError ?? new Error('CDP 求值失败')
  }
  const payloadText = result?.result?.value
  if (typeof payloadText !== 'string') {
    throw new Error(`CDP 返回异常: ${JSON.stringify(result)}`)
  }
  const payload = JSON.parse(payloadText)
  console.log('SMOKE', JSON.stringify(payload, null, 2))

  const checks = {
    hasApi: payload.hasApi === true,
    fourEntries: payload.navCount === 4,
    projectPageRendered: payload.hasProjectPage === true,
    isolatedUserData: payload.isolated === true,
    projectListWorks: payload.projectsOk === true,
    vendorKeyStatusWorks: payload.vendorOk === true,
    auditListWorks: payload.auditOk === true,
    controlStatusWorks: payload.controlOk === true,
    failClosedWithoutKey: payload.vendorConfigured === false ? payload.controlValue === null : true,
    createWorks: payload.createdOk === true,
    listRefreshed: payload.listRefreshed === true,
    duplicateRejected: payload.duplicateRejected === true,
    auditRecorded: payload.auditRecorded === true
  }
  const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key)
  if (failed.length > 0) {
    console.error('SMOKE_FAILED', failed.join(','))
    exitCode = 1
  } else {
    console.log('SMOKE_OK')
  }
} catch (error) {
  console.error('SMOKE_ERROR', error instanceof Error ? error.message : String(error))
  exitCode = 1
} finally {
  child.kill()
  await timeout(600)
  rmSync(tempUserData, { recursive: true, force: true })
}
process.exit(exitCode)
