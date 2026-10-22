import { app, ipcMain } from 'electron'
import { IPC_CHANNELS, type AppInfo } from '@shared/ipc-contract'

function collectAppInfo(): AppInfo {
  return {
    appName: app.getName(),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node,
    userDataPath: app.getPath('userData')
  }
}

export function registerAppIpc(): void {
  ipcMain.handle(IPC_CHANNELS.appGetInfo, (): AppInfo => collectAppInfo())
}
