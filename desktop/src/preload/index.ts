import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type AppInfo } from '@shared/ipc-contract'
import { LICENSE_IPC_CHANNELS } from '@shared/license/service-contract'
import type { AegisApi } from '@shared/api'

/**
 * 只暴露白名单方法；不暴露 ipcRenderer 本体，渲染进程无法自造通道调用，
 * 也拿不到 fs / 数据库 / 私钥。
 */
const api: AegisApi = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo),
  license: {
    listProjects: () => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.projectList),
    createProject: (input) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.projectCreate, input),
    updateProject: (input) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.projectUpdate, input),

    listDevices: (options) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.deviceList, options),
    registerDevice: (input) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.deviceRegister, input),
    unbindDevice: (input) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.deviceUnbind, input),
    lockDevice: (input) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.deviceLock, input),
    unlockDevice: (input) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.deviceUnlock, input),
    deviceStatus: (input) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.deviceStatus, input),

    importControlCertificate: (envelopeText) =>
      ipcRenderer.invoke(LICENSE_IPC_CHANNELS.controlImport, envelopeText),
    pickControlCertificateFile: () => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.controlPickFile),
    currentControlCertificate: () => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.controlCurrent),
    lastControlCertificate: () => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.controlLast),
    quota: () => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.quotaUsage),

    delegatedKeyStatus: () => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.delegatedKeyStatus),
    importDelegatedKey: (pemText) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.delegatedKeyImport, pemText),
    vendorKeyStatus: () => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.vendorKeyStatus),

    issueLicense: (input) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.licenseIssue, input),
    issueLicensesBatch: (input) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.licenseBatchIssue, input),
    renewLicense: (input) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.licenseRenew, input),
    listLicenses: (options) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.licenseList, options),

    listAuditLogs: (options) => ipcRenderer.invoke(LICENSE_IPC_CHANNELS.auditList, options)
  }
}

contextBridge.exposeInMainWorld('aegis', api)
