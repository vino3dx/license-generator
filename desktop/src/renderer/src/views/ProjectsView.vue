<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ControlCertificateDto, ProjectDto } from '@shared/license/service-contract'
import NoticeBanner from '@renderer/components/NoticeBanner.vue'
import PageHeader from '@renderer/components/PageHeader.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import ModalDialog from '@renderer/components/ModalDialog.vue'
import { errorMessage, licenseApi, unwrap } from '@renderer/lib/api'
import { formatDateTime, PROJECT_STATUS_LABEL } from '@renderer/lib/format'

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const MAX_NAME = 128

const projects = ref<ProjectDto[]>([])
const certificate = ref<ControlCertificateDto | null>(null)
const loading = ref(false)
const notice = ref<{ message: string; tone: 'danger' | 'success' | 'info' } | null>(null)

const createForm = ref({ projectId: '', name: '' })
const createError = ref('')
const creating = ref(false)

const editing = ref<ProjectDto | null>(null)
const editName = ref('')
const editError = ref('')
const saving = ref(false)

const viewing = ref<ProjectDto | null>(null)

const scopeLabel = computed(() => {
  if (certificate.value === null) {
    return '未导入中控证书'
  }
  const ids = certificate.value.projectIds
  return ids.includes('*') ? '全部项目' : ids.join('、')
})

function inScope(projectId: string): boolean {
  if (certificate.value === null) {
    return false
  }
  const ids = certificate.value.projectIds
  return ids.includes('*') || ids.includes(projectId)
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const api = licenseApi()
    const [list, current] = await Promise.all([api.listProjects(), api.currentControlCertificate()])
    projects.value = unwrap(list)
    certificate.value = unwrap(current)
  } catch (error) {
    notice.value = { message: errorMessage(error), tone: 'danger' }
  } finally {
    loading.value = false
  }
}

async function submitCreate(): Promise<void> {
  createError.value = ''
  const projectId = createForm.value.projectId.trim()
  const name = createForm.value.name.trim()
  if (!ID_PATTERN.test(projectId)) {
    createError.value = '项目 ID 只能包含字母、数字、点、下划线、冒号和短横线，长度 1–128'
    return
  }
  if (name.length === 0 || name.length > MAX_NAME) {
    createError.value = `项目名称长度必须为 1–${MAX_NAME}`
    return
  }
  if (projects.value.some((item) => item.projectId === projectId)) {
    createError.value = `项目 ID ${projectId} 已存在`
    return
  }
  creating.value = true
  try {
    const created = unwrap(await licenseApi().createProject({ projectId, name }))
    projects.value = [...projects.value, created].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    createForm.value = { projectId: '', name: '' }
    notice.value = { message: `项目 ${projectId} 已创建`, tone: 'success' }
  } catch (error) {
    createError.value = errorMessage(error)
  } finally {
    creating.value = false
  }
}

function startEdit(project: ProjectDto): void {
  editing.value = project
  editName.value = project.name
  editError.value = ''
}

async function submitEdit(): Promise<void> {
  if (editing.value === null) {
    return
  }
  editError.value = ''
  const name = editName.value.trim()
  if (name.length === 0 || name.length > MAX_NAME) {
    editError.value = `项目名称长度必须为 1–${MAX_NAME}`
    return
  }
  saving.value = true
  try {
    const updated = unwrap(
      await licenseApi().updateProject({ projectId: editing.value.projectId, name })
    )
    projects.value = projects.value.map((item) => (item.projectId === updated.projectId ? updated : item))
    notice.value = { message: `项目 ${updated.projectId} 已更新`, tone: 'success' }
    editing.value = null
  } catch (error) {
    editError.value = errorMessage(error)
  } finally {
    saving.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <section class="page">
    <PageHeader title="项目管理" description="项目是设备与子机授权的归属单位；project_id 必须与 Godot 插件 Dock 显示的值一致。">
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
        <h3>新建项目</h3>
        <span class="hint">中控证书范围：{{ scopeLabel }}</span>
      </div>
      <form class="form-grid" @submit.prevent="submitCreate">
        <label class="field">
          <span>项目 ID</span>
          <input v-model="createForm.projectId" placeholder="从 Godot 插件 Dock 复制，例如 3f9a1c7d20" />
        </label>
        <label class="field">
          <span>项目名称</span>
          <input v-model="createForm.name" placeholder="客户或产品名称" />
        </label>
        <div class="field field--action">
          <button type="submit" class="btn btn--primary" :disabled="creating">
            {{ creating ? '创建中…' : '创建项目' }}
          </button>
        </div>
      </form>
      <p v-if="createError.length > 0" class="form-error">{{ createError }}</p>
      <p class="hint">
        项目 ID 由 Godot 插件按「工程名 + 共享密钥」计算，中控不能另生成一套；填错会导致子机验签时项目不匹配。
      </p>
    </div>

    <div class="card">
      <div class="card__title">
        <h3>项目列表</h3>
        <span class="hint">共 {{ projects.length }} 个</span>
      </div>
      <p v-if="loading" class="hint">正在加载…</p>
      <p v-else-if="projects.length === 0" class="hint">还没有项目。先创建项目，再登记设备。</p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>项目 ID</th>
            <th>名称</th>
            <th>状态</th>
            <th>中控范围</th>
            <th>创建时间</th>
            <th class="table__actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="project in projects" :key="project.projectId">
            <td class="mono">{{ project.projectId }}</td>
            <td>{{ project.name }}</td>
            <td>
              <StatusBadge
                :tone="project.status === 'active' ? 'ok' : 'muted'"
                :text="PROJECT_STATUS_LABEL[project.status] ?? project.status"
              />
            </td>
            <td>
              <StatusBadge
                :tone="inScope(project.projectId) ? 'ok' : 'warn'"
                :text="inScope(project.projectId) ? '在范围内' : '不在范围'"
              />
            </td>
            <td>{{ formatDateTime(project.createdAt) }}</td>
            <td class="table__actions">
              <button type="button" class="btn btn--ghost" @click="viewing = project">查看</button>
              <button type="button" class="btn btn--ghost" @click="startEdit(project)">编辑</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ModalDialog :open="editing !== null" title="编辑项目" @close="editing = null">
      <div v-if="editing !== null" class="form-grid form-grid--single">
        <label class="field">
          <span>项目 ID（不可修改）</span>
          <input :value="editing.projectId" disabled />
        </label>
        <label class="field">
          <span>项目名称</span>
          <input v-model="editName" />
        </label>
        <p v-if="editError.length > 0" class="form-error">{{ editError }}</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="editing = null">取消</button>
        <button type="button" class="btn btn--primary" :disabled="saving" @click="submitEdit">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </template>
    </ModalDialog>

    <ModalDialog :open="viewing !== null" title="项目详情" @close="viewing = null">
      <dl v-if="viewing !== null" class="detail-list">
        <dt>项目 ID</dt>
        <dd class="mono">{{ viewing.projectId }}</dd>
        <dt>名称</dt>
        <dd>{{ viewing.name }}</dd>
        <dt>状态</dt>
        <dd>{{ PROJECT_STATUS_LABEL[viewing.status] ?? viewing.status }}</dd>
        <dt>创建时间</dt>
        <dd>{{ formatDateTime(viewing.createdAt) }}</dd>
        <dt>中控授权范围</dt>
        <dd>{{ inScope(viewing.projectId) ? '已包含' : '未包含，无法登记设备或签发' }}</dd>
      </dl>
    </ModalDialog>
  </section>
</template>
