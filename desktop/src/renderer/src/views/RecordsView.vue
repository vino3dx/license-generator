<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AuditLogDto } from '@shared/license/service-contract'
import NoticeBanner from '@renderer/components/NoticeBanner.vue'
import PageHeader from '@renderer/components/PageHeader.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import ModalDialog from '@renderer/components/ModalDialog.vue'
import { errorMessage, licenseApi, unwrap } from '@renderer/lib/api'
import { auditActionLabel, formatDateTime } from '@renderer/lib/format'

const ACTIONS = [
  'project_create',
  'project_update',
  'device_register',
  'device_lock',
  'device_unlock',
  'device_unbind',
  'control_certificate_import',
  'delegated_key_import',
  'license_issue',
  'license_batch_issue',
  'license_renew',
  'license_reconcile'
] as const

const logs = ref<AuditLogDto[]>([])
const loading = ref(false)
const notice = ref<{ message: string; tone: 'danger' | 'success' | 'info' } | null>(null)

const filterAction = ref('')
const filterTarget = ref('')
const filterLimit = ref(200)

const viewing = ref<AuditLogDto | null>(null)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    logs.value = unwrap(
      await licenseApi().listAuditLogs({
        limit: filterLimit.value,
        ...(filterAction.value.length > 0 ? { action: filterAction.value } : {}),
        ...(filterTarget.value.trim().length > 0 ? { targetId: filterTarget.value.trim() } : {})
      })
    )
  } catch (error) {
    notice.value = { message: errorMessage(error), tone: 'danger' }
  } finally {
    loading.value = false
  }
}

function resetFilters(): void {
  filterAction.value = ''
  filterTarget.value = ''
  filterLimit.value = 200
  void refresh()
}

function prettyContext(context: string | null): string {
  if (context === null || context.length === 0) {
    return '（无上下文）'
  }
  try {
    return JSON.stringify(JSON.parse(context), null, 2)
  } catch {
    return context
  }
}

onMounted(refresh)
</script>

<template>
  <section class="page">
    <PageHeader
      title="签发记录"
      description="审计日志只追加不修改；这里的记录由业务层写入，界面不能伪造。"
    >
      <template #actions>
        <button type="button" class="btn" :disabled="loading" @click="refresh">刷新</button>
      </template>
    </PageHeader>

    <NoticeBanner
      v-if="notice !== null"
      :message="notice.message"
      :tone="notice.tone"
      @dismiss="notice = null"
    />

    <div class="card">
      <div class="card__title">
        <h3>筛选</h3>
        <span class="hint">共 {{ logs.length }} 条</span>
      </div>
      <form class="form-grid form-grid--filters" @submit.prevent="refresh">
        <label class="field">
          <span>操作类型</span>
          <select v-model="filterAction">
            <option value="">全部操作</option>
            <option v-for="action in ACTIONS" :key="action" :value="action">
              {{ auditActionLabel(action) }}（{{ action }}）
            </option>
          </select>
        </label>
        <label class="field">
          <span>对象 ID</span>
          <input v-model="filterTarget" placeholder="项目 / 设备 / 授权 ID" />
        </label>
        <label class="field field--narrow">
          <span>条数上限</span>
          <input v-model.number="filterLimit" type="number" min="1" max="1000" />
        </label>
        <div class="field field--action">
          <button type="submit" class="btn btn--primary" :disabled="loading">查询</button>
          <button type="button" class="btn" @click="resetFilters">重置</button>
        </div>
      </form>
    </div>

    <div class="card">
      <div class="card__title">
        <h3>审计记录</h3>
      </div>
      <p v-if="loading" class="hint">正在加载…</p>
      <p v-else-if="logs.length === 0" class="hint">没有符合条件的记录。</p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>操作</th>
            <th>对象</th>
            <th>结果</th>
            <th>错误码</th>
            <th>操作者</th>
            <th class="table__actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in logs" :key="log.id">
            <td>{{ formatDateTime(log.at) }}</td>
            <td>{{ auditActionLabel(log.action) }}</td>
            <td>
              <span class="mono">{{ log.targetId }}</span>
              <span class="hint">（{{ log.targetType }}）</span>
            </td>
            <td>
              <StatusBadge
                :tone="log.result === 'success' ? 'ok' : 'danger'"
                :text="log.result === 'success' ? '成功' : '失败'"
              />
            </td>
            <td class="mono">{{ log.errorCode ?? '—' }}</td>
            <td>{{ log.actor }}</td>
            <td class="table__actions">
              <button type="button" class="btn btn--ghost" @click="viewing = log">详情</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ModalDialog :open="viewing !== null" title="审计详情" width="640px" @close="viewing = null">
      <div v-if="viewing !== null">
        <dl class="detail-list">
          <dt>记录 ID</dt>
          <dd>{{ viewing.id }}</dd>
          <dt>时间</dt>
          <dd>{{ formatDateTime(viewing.at) }}</dd>
          <dt>操作</dt>
          <dd>{{ auditActionLabel(viewing.action) }}（{{ viewing.action }}）</dd>
          <dt>对象</dt>
          <dd class="mono">{{ viewing.targetType }} / {{ viewing.targetId }}</dd>
          <dt>结果</dt>
          <dd>{{ viewing.result === 'success' ? '成功' : '失败' }}</dd>
          <dt>错误码</dt>
          <dd class="mono">{{ viewing.errorCode ?? '—' }}</dd>
          <dt>操作者</dt>
          <dd>{{ viewing.actor }}</dd>
        </dl>
        <h4>上下文</h4>
        <pre class="code-block">{{ prettyContext(viewing.context) }}</pre>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="viewing = null">关闭</button>
      </template>
    </ModalDialog>
  </section>
</template>
