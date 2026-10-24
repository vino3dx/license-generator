import { app, BrowserWindow, Menu } from 'electron'
import { registerIpcHandlers } from './ipc'
import { disposeHub } from './hub/hub-runtime'
import { closeLicenseRuntime, initLicenseRuntime } from './license-runtime'
import { createMainWindow } from './window'

/** 单实例：避免多个中控同时持有数据库连接 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setAppUserModelId('com.aegis.console')

  let mainWindow: BrowserWindow | null = null

  app.on('second-instance', () => {
    if (mainWindow === null) {
      return
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    initLicenseRuntime()
    registerIpcHandlers()

    if (app.isPackaged) {
      Menu.setApplicationMenu(null)
    }

    mainWindow = createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('will-quit', () => {
    // 先释放网络监听，再关数据库；不能残留 47820/47821 端口
    disposeHub()
    closeLicenseRuntime()
  })
}
