/**
 * 主进程与渲染进程之间唯一的契约来源。
 * 约束：这里只放通道名、请求/响应类型和工作区元数据，不放任何实现。
 */

export const IPC_CHANNELS = {
  /** 读取只读的应用与运行环境信息 */
  appGetInfo: 'app:get-info'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/** 运行环境信息：由主进程提供，渲染进程只读 */
export interface AppInfo {
  readonly appName: string
  readonly appVersion: string
  readonly isPackaged: boolean
  readonly platform: string
  readonly electronVersion: string
  readonly chromeVersion: string
  readonly nodeVersion: string
  /** 数据库、日志等可写数据的根目录（应用数据目录，不是安装目录） */
  readonly userDataPath: string
}

export type WorkspaceKey = 'projects' | 'devices' | 'issue' | 'records'

export interface WorkspaceEntry {
  readonly key: WorkspaceKey
  readonly title: string
  readonly summary: string
}

/** 主界面四个入口，界面与后续路由/权限共用同一份定义 */
export const WORKSPACE_ENTRIES: readonly WorkspaceEntry[] = [
  { key: 'projects', title: '项目管理', summary: '维护项目 ID、项目范围与授权额度' },
  { key: 'devices', title: '设备管理', summary: '登记子机设备、所属项目与锁定状态' },
  { key: 'issue', title: '授权签发', summary: '单台或批量签发、续期子机授权' },
  { key: 'records', title: '签发记录', summary: '签发结果、操作者与审计日志' }
] as const
