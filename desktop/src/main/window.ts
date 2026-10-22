import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

/** 允许外链跳转的协议白名单，其余一律拦截 */
const EXTERNAL_PROTOCOLS = ['https:', 'mailto:']

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1420',
    title: 'Aegis 授权管理',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全基线：渲染进程无 Node 权限，preload 走独立上下文
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  // 禁止应用内打开新窗口，外链交给系统浏览器
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // 禁止渲染进程导航到非本应用页面
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault()
    }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl !== undefined && devServerUrl !== '') {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function isAllowedExternal(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.includes(new URL(url).protocol)
  } catch {
    return false
  }
}
