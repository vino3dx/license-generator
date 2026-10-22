import { readFileSync } from 'node:fs'
import { dialog } from 'electron'
import { ServiceError } from '@core/services'

/**
 * 中控证书文件选择。
 *
 * 放在主进程独立模块里，而不是 IPC 注册文件：
 * - 渲染进程只能通过 IPC 触发系统文件对话框，拿不到任意路径读取能力；
 * - IPC 层保持“只做参数收敛与错误封包”，不直接接触文件系统。
 */
const MAX_CERTIFICATE_FILE_BYTES = 64 * 1024

export async function pickControlCertificateText(): Promise<string | null> {
  const selection = await dialog.showOpenDialog({
    title: '选择中控授权证书',
    properties: ['openFile'],
    filters: [{ name: '中控授权证书', extensions: ['cert', 'json', 'txt'] }]
  })
  if (selection.canceled || selection.filePaths.length === 0) {
    return null
  }
  const filePath = selection.filePaths[0]
  if (filePath === undefined) {
    return null
  }
  const text = readFileSync(filePath, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > MAX_CERTIFICATE_FILE_BYTES) {
    throw new ServiceError('invalid_argument', '证书文件超过大小上限')
  }
  return text
}
