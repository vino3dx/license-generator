<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type {
  DeviceDto,
  DeviceLicenseStatusDto,
  ProjectDto,
  QuotaUsageDto
} from '@shared/license/service-contract'
import NoticeBanner from '@renderer/components/NoticeBanner.vue'
import PageHeader from '@renderer/components/PageHeader.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import ModalDialog from '@renderer/components/ModalDialog.vue'
import { errorMessage, licenseApi, unwrap } from '@renderer/lib/api'
import { daysUntil, fileCheckLabel, fileCheckOk, formatDateTime, LICENSE_STATUS_LABEL } from '@renderer/lib/format'

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

const projects = ref<ProjectDto[]>([])
const devices = ref<DeviceDto[]>([])
const quota = ref<QuotaUsageDto | null>(null)
const filterProject = ref('')
const includeUnbound = ref(false)
const loading = ref(false)
const notice = ref<{ message: string; tone: 'danger' | 'success' | 'info' } | null>(null)

const registerForm = ref({ projectId: '', deviceId: '' })
const registerError = ref('')
const registering = ref(false)

const locking = ref<string | null>(null)
const unbinding = ref<DeviceDto | null>(null)
const unbindReason = ref('')
const unbindError = ref('')
const unbindBusy = ref(false)

const statusTarget = ref<DeviceDto | null>(null)
const statusDetail = ref<DeviceLicenseStatusDto | null>(null)
const statusError = ref('')
const statusLoading = ref(false)

const quotaText = computed(() => {
  if (quota.value === null) {
    return '额度不可用（需要有效中控证书）'
  }
  return `已用 ${quota.value.usedDevices} / ${quota.value.maxDevices}`
})

const quotaExhausted = computed(
  () => quota.value !== null && quota.value.usedDevices >= quota.value.maxDevices
)

function deviceTone(device: DeviceDto): 'ok' | 'warn' | 'muted' {
  if (device.unbindAt !== null) {
    return 'muted'
  }
  return device.locked ? 'warn' : 'ok'
}

function deviceState(device: DeviceDto): string {
  if (device.unbindAt !== null) {
    return '已解绑'
  }
  return device.locked ? '已锁定' : '正常'
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const api = licenseApi()
    const [projectList, deviceList, quotaResult] = await Promise.all([
      api.listProjects(),
      api.listDevices({
        projectId: filterProject.value.length > 0 ? filterProject.value : undefined,
        includeUnbound: includeUnbound.value
      }),
      api.quota()
    ])
    projects.value = unwrap(projectList)
    devices.value = unwrap(deviceList)
    quota.value = quotaResult.ok ? quotaResult.value : null
    if (registerForm.value.projectId.length === 0 && projects.value.length > 0) {
      registerForm.value.projectId = projects.value[0]?.projectId ?? ''
    }
  } catch (error) {
    notice.value = { message: errorMessage(error), tone: 'danger' }
  } finally {
    loading.value = false
  }
}

async function submitRegister(): Promise<void> {
  registerError.value = ''
  const projectId = registerForm.value.projectId
  const deviceId = registerForm.value.deviceId.trim()
  if (projectId.length === 0) {
    registerError.value = '请选择项目'
    return
  }
  if (!ID_PATTERN.test(deviceId)) {
    registerError.value = '设备 ID 只能包含字母、数字、点、下划线、冒号和短横线，长度 1–128'
    return
  }
  registering.value = true
  try {
    const created = unwrap(await licenseApi().registerDevice({ projectId, deviceId }))
    notice.value = { message: `设备 ${created.deviceId} 已登记到 ${created.projectId}`, tone: 'success' }
    registerForm.value.deviceId = ''
    await refresh()
  } catch (error) {
    registerError.value = errorMessage(error)
  } finally {
    registering.value = false
  }
}

async function toggleLock(device: DeviceDto): Promise<void> {
  locking.value = `${device.projectId}/${device.deviceId}`
  try {
    const action = device.locked ? licenseApi().unlockDevice : licenseApi().lockDevice
    unwrap(await action({ projectId: device.projectId, deviceId: device.deviceId }))
    notice.value = {
      message: device.locked ? `设备 ${device.deviceId} 已解锁` : `设备 ${device.deviceId} 已锁定`,
      tone: 'success'
    }
    await refresh()
  } catch (error) {
    notice.value = { message: errorMessage(error), tone: 'danger' }
  } finally {
    locking.value = null
  }
}

function startUnbind(device: DeviceDto): void {
  unbinding.value = device
  unbindReason.value = ''
  unbindError.value = ''
}

async function submitUnbind(): Promise<void> {
  if (unbinding.value === null) {
    return
  }
  unbindError.value = ''
  const reason = unbindReason.value.trim()
  if (reason.length === 0) {
    unbindError.value = '解绑必须填写原因，便于审计追溯'
    return
  }
  unbindBusy.value = true
  try {
    unwrap(
      await licenseApi().unbindDevice({
        projectId: unbinding.value.projectId,
        deviceId: unbinding.value.deviceId,
        reason
      })
    )
    notice.value = { message: `设备 ${unbinding.value.deviceId} 已解绑，额度已释放`, tone: 'success' }
    unbinding.value = null
    await refresh()
  } catch (error) {
    unbindError.value = errorMessage(error)
  } finally {
    unbindBusy.value = false
  }
}

async function openStatus(device: DeviceDto): Promise<void> {
  statusTarget.value = device
  statusDetail.value = null
  statusError.value = ''
  statusLoading.value = true
  try {
    statusDetail.value = unwrap(
      await licenseApi().deviceStatus({ projectId: device.projectId, deviceId: device.deviceId })
    )
  } catch (error) {
    statusError.value = errorMessage(error)
  } finally {
    statusLoading.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <section class="page">
    <PageHeader
      title="设备管理"
      description="这里只记录中控掌握的授权事实（登记、锁定、解绑），不代表子机实时在线或已收到锁定命令。"
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

    <div class="stat-row">
      <div class="stat">
        <span class="stat__label">设备额度</span>
        <strong class="stat__value">{{ quotaText }}</strong>
        <StatusBadge v-if="quotaExhausted" tone="warn" text="额度已用尽" />
      </div>
      <div class="stat">
        <span class="stat__label">当前列表</span>
        <strong class="stat__value">{{ devices.length }} 台</strong>
      </div>
    </div>

    <div class="card">
      <div class="card__title">
        <h3>登记设备</h3>
        <span class="hint">锁定设备仍占用额度；解绑后释放额度并留审计记录</span>
      </div>
      <form class="form-grid" @submit.prevent="submitRegister">
        <label class="field">
          <span>所属项目</span>
          <select v-model="registerForm.projectId">
            <option value="" disabled>请选择项目</option>
            <option v-for="project in projects" :key="project.projectId" :value="project.projectId">
              {{ project.name }}（{{ project.projectId }}）
            </option>
          </select>
        </label>
        <label class="field">
          <span>设备 ID</span>
          <input v-model="registerForm.deviceId" placeholder="从子机插件 Dock 复制，例如 DEV-1a2b3c4d5e6f7788" />
        </label>
        <div class="field field--action">
          <button type="submit" class="btn btn--primary" :disabled="registering || quotaExhausted">
            {{ registering ? '登记中…' : '登记设备' }}
          </button>
        </div>
      </form>
      <p v-if="registerError.length > 0" class="form-error">{{ registerError }}</p>
    </div>

    <div class="card">
      <div class="card__title">
        <h3>设备列表</h3>
        <div class="filters">
          <label class="field field--inline">
            <span>项目</span>
            <select v-model="filterProject" @change="refresh">
              <option value="">全部项目</option>
              <option v-for="project in projects" :key="project.projectId" :value="project.projectId">
                {{ project.name }}
              </option>
            </select>
          </label>
          <label class="checkbox">
            <input v-model="includeUnbound" type="checkbox" @change="refresh" />
            <span>包含已解绑</span>
          </label>
        </div>
      </div>

      <p v-if="loading" class="hint">正在加载…</p>
      <p v-else-if="devices.length === 0" class="hint">没有符合条件的设备。</p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>设备 ID</th>
            <th>所属项目</th>
            <th>登记时间</th>
            <th>状态</th>
            <th>解绑时间</th>
            <th class="table__actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="device in devices" :key="`${device.projectId}/${device.deviceId}`">
            <td class="mono">{{ device.deviceId }}</td>
            <td class="mono">{{ device.projectId }}</td>
            <td>{{ formatDateTime(device.registeredAt) }}</td>
            <td><StatusBadge :tone="deviceTone(device)" :text="deviceState(device)" /></td>
            <td>{{ formatDateTime(device.unbindAt) }}</td>
            <td class="table__actions">
              <button type="button" class="btn btn--ghost" @click="openStatus(device)">授权状态</button>
              <button
                v-if="device.unbindAt === null"
                type="button"
                class="btn btn--ghost"
                :disabled="locking === `${device.projectId}/${device.deviceId}`"
                @click="toggleLock(device)"
              >
                {{ device.locked ? '解锁' : '锁定' }}
              </button>
              <button
                v-if="device.unbindAt === null"
                type="button"
                class="btn btn--danger"
                @click="startUnbind(device)"
              >
                解绑
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ModalDialog :open="unbinding !== null" title="解绑设备" @close="unbinding = null">
      <div v-if="unbinding !== null" class="form-grid form-grid--single">
        <p class="hint">
          设备 <span class="mono">{{ unbinding.deviceId }}</span> 解绑后释放一个设备名额，已签发的授权文件不会自动失效，
          但不再计入额度。
        </p>
        <label class="field">
          <span>解绑原因（必填，写入审计）</span>
          <input v-model="unbindReason" placeholder="例如：客户更换主机 / 设备报废" />
        </label>
        <p v-if="unbindError.length > 0" class="form-error">{{ unbindError }}</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="unbinding = null">取消</button>
        <button type="button" class="btn btn--danger" :disabled="unbindBusy" @click="submitUnbind">
          {{ unbindBusy ? '处理中…' : '确认解绑' }}
        </button>
      </template>
    </ModalDialog>

    <ModalDialog :open="statusTarget !== null" title="设备授权状态" width="640px" @close="statusTarget = null">
      <div v-if="statusTarget !== null">
        <p class="hint">
          数据库记录只用于定位授权文件，下面的文件校验结果才是真实验签结论。
        </p>
        <dl class="detail-list">
          <dt>设备 ID</dt>
          <dd class="mono">{{ statusTarget.deviceId }}</dd>
          <dt>所属项目</dt>
          <dd class="mono">{{ statusTarget.projectId }}</dd>
          <dt>登记 / 锁定 / 解绑</dt>
          <dd>
            {{ formatDateTime(statusTarget.registeredAt) }} /
            {{ formatDateTime(statusTarget.lockedAt) }} /
            {{ formatDateTime(statusTarget.unbindAt) }}
          </dd>
        </dl>

        <p v-if="statusLoading" class="hint">正在校验授权文件…</p>
        <p v-else-if="statusError.length > 0" class="form-error">{{ statusError }}</p>
        <template v-else-if="statusDetail !== null">
          <dl v-if="statusDetail.license !== null" class="detail-list">
            <dt>授权 ID</dt>
            <dd class="mono">{{ statusDetail.license.licenseId }}</dd>
            <dt>授权状态</dt>
            <dd>{{ LICENSE_STATUS_LABEL[statusDetail.license.status] ?? statusDetail.license.status }}</dd>
            <dt>到期时间</dt>
            <dd>
              {{ formatDateTime(statusDetail.license.expiresAt) }}
              <span v-if="daysUntil(statusDetail.license.expiresAt) !== null" class="hint">
                （剩余 {{ daysUntil(statusDetail.license.expiresAt) }} 天）
              </span>
            </dd>
            <dt>授权文件</dt>
            <dd class="mono">{{ statusDetail.license.fileName }}</dd>
            <dt>文件校验</dt>
            <dd>
              <StatusBadge
                :tone="fileCheckOk(statusDetail.file.code) ? 'ok' : 'danger'"
                :text="fileCheckLabel(statusDetail.file.code)"
              />
            </dd>
          </dl>
          <p v-else class="hint">该设备尚未签发授权。</p>
        </template>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="statusTarget = null">关闭</button>
      </template>
    </ModalDialog>
  </section>
</template>
