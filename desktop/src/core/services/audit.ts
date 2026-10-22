import { appendAuditLog } from '@core/db'
import type { ResolvedDependencies } from './context'

export interface AuditInput {
  readonly at: string
  readonly action: string
  readonly targetType: string
  readonly targetId: string
  readonly result: 'success' | 'failure'
  readonly errorCode: string | null
  readonly context: string | null
}

/**
 * 统一的审计写入：自动补上操作者，禁止调用方自行拼 actor。
 * context 必须是已脱敏的 JSON，不得包含私钥或完整授权文件。
 */
export function writeAudit(deps: ResolvedDependencies, entry: AuditInput): void {
  appendAuditLog(deps.database, {
    at: entry.at,
    actor: deps.actor,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    result: entry.result,
    errorCode: entry.errorCode,
    context: entry.context
  })
}
