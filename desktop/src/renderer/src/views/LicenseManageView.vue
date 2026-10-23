<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type {
  ControlCertificateDto,
  DeviceDto,
  DeviceLicenseStatusDto,
  LicenseDto,
  ProjectDto,
  QuotaUsageDto,
  DelegatedKeyStatusDto,
  VendorKeyStatusDto
} from '@shared/license/service-contract'
import NoticeBanner from '@renderer/components/NoticeBanner.vue'
import PageHeader from '@renderer/components/PageHeader.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import ModalDialog from '@renderer/components/ModalDialog.vue'
import { appApi, errorMessage, licenseApi, unwrap } from '@renderer/lib/api'
import {
  daysUntil,
  fileCheckLabel,
  fileCheckOk,
  formatDateTime,
  localInputToUtc,
  LICENSE_STATUS_LABEL
} from '@renderer/lib/format'

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const MAX_NAME = 128

/** 证书导入后的项目初始化结果与被系统一状态机（与"证书是否导入成功"分开呈现） */
type ProjectInitStatus = 'idle' | 'running' | 'done' | 'partial' | 'failed' | 'skipped'

interface ProjectInitState {
  readonly status: ProjectInitStatus
  readonly created: readonly string[]
  readonly existing: readonly string[]
  readonly failed: readonly { readonly projectId: string; readonly message: string }[]
  /** skipped 的原因（例如证书为通配项目范围） */
  readonly reason: string
}

/** 多行登记的单台结果：成功 / 已存在（不重复请求）/ 失败 */
interface RegisterResult {
  readonly deviceId: string
  readonly status: 'created' | 'exists' | 'failed'
  readonly message: string
}

const projects = ref<ProjectDto[]>([])
const devices = ref<DeviceDto[]>([])
const certificate = ref<ControlCertificateDto | null>(null)
const lastCertificate = ref<ControlCertificateDto | null>(null)
const quota = ref<QuotaUsageDto | null>(null)
const vendorKey = ref<VendorKeyStatusDto | null>(null)
const delegatedKey = ref<DelegatedKeyStatusDto | null>(null)
const userDataPath = ref('')
const loading = ref(false)
const notice = ref<{ message: string; tone: 'danger' | 'success' | 'info' } | null>(null)

const activeProject = ref('')
const selectedDeviceIds = ref<string[]>([])
const expiresLocal = ref('')
const submitting = ref(false)
const submitError = ref('')
const issued = ref<LicenseDto[]>([])

const createForm = ref({ projectId: '', name: '' })
const createError = ref('')
const creating = ref(false)
const editing = ref<ProjectDto | null>(null)
const editName = ref('')
const editError = ref('')
const saving = ref(false)

const registerForm = ref({ deviceId: '' })
const registerError = ref('')
const registerResults = ref<RegisterResult[]>([])
const registering = ref(false)
const projectInit = ref<ProjectInitState>({
  status: 'idle',
  created: [],
  existing: [],
  failed: [],
  reason: ''
})
const locking = ref<string | null>(null)
const unbinding = ref<DeviceDto | null>(null)
const unbindReason = ref('')
const unbindError = ref('')
const unbindBusy = ref(false)
const statusTarget = ref<DeviceDto | null>(null)
const statusDetail = ref<DeviceLicenseStatusDto | null>(null)
const statusError = ref('')
const statusLoading = ref(false)

const certificateText = ref('')
const certificateError = ref('')
const importingCertificate = ref(false)
const showCertificateImport = ref(false)
const privateKeyText = ref('')
const privateKeyError = ref('')
const importingKey = ref(false)
const showKeyImport = ref(false)

/** 证书已过期（导入时即被拒绝，这里兜底展示） */
const certificateExpired = computed(() => {
  if (certificate.value === null) {
    return false
  }
  const days = daysUntil(certificate.value.expiresAt)
  return days !== null && days <= 0
})

/** 一次性证书：没有生效证书，但最近导入过一张且已作废 */
const certificateConsumed = computed(
  () => certificate.value === null && lastCertificate.value !== null && !lastCertificate.value.isActive
)

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

const quotaText = computed(() => {
  if (quota.value === null) {
    return '不可用（需要生效中控证书）'
  }
  return `${quota.value.usedDevices} / ${quota.value.maxDevices}`
})

const quotaExhausted = computed(
  () => quota.value !== null && quota.value.usedDevices >= quota.value.maxDevices
)

const canIssue = computed(
  () =>
    certificate.value !== null &&
    !certificateExpired.value &&
    vendorKey.value?.configured === true &&
    delegatedKey.value?.configured === true &&
    delegatedKey.value?.matchesControl !== false
)

const issuanceBlockReason = computed(() => {
  if (vendorKey.value !== null && !vendorKey.value.configured) {
    return '当前构建未配置厂商公钥，无法验证中控证书，也不能签发'
  }
  if (certificateConsumed.value) {
    return '中控证书已使用并作废（一次性证书），请导入新证书后再签发'
  }
  if (certificate.value === null) {
    return '尚未导入中控授权证书：第一步先导入厂商签发的中控证书'
  }
  if (certificateExpired.value) {
    return '中控证书已过期，不能继续签发'
  }
  if (delegatedKey.value === null || !delegatedKey.value.configured) {
    return '本机未配置委托签发私钥'
  }
  if (delegatedKey.value.matchesControl === false) {
    return '委托私钥与中控证书不匹配'
  }
  return ''
})

const activeDevices = computed(() =>
  devices.value.filter((device) => device.unbindAt === null)
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

async function refreshAll(): Promise<void> {
  loading.value = true
  try {
    const api = licenseApi()
    const [projectList, controlResult, lastResult, quotaResult, vendorResult, keyResult] = await Promise.all([
      api.listProjects(),
      api.currentControlCertificate(),
      api.lastControlCertificate(),
      api.quota(),
      api.vendorKeyStatus(),
      api.delegatedKeyStatus()
    ])
    projects.value = unwrap(projectList)
    certificate.value = unwrap(controlResult)
    lastCertificate.value = unwrap(lastResult)
    quota.value = quotaResult.ok ? quotaResult.value : null
    vendorKey.value = unwrap(vendorResult)
    delegatedKey.value = unwrap(keyResult)
    if (activeProject.value.length === 0 && projects.value.length > 0) {
      activeProject.value = projects.value[0]?.projectId ?? ''
    }
    await loadDevices()
  } catch (error) {
    notice.value = { message: errorMessage(error), tone: 'danger' }
  } finally {
    loading.value = false
  }
}

async function loadDevices(): Promise<void> {
  selectedDeviceIds.value = []
  if (activeProject.value.length === 0) {
    devices.value = []
    return
  }
  try {
    devices.value = unwrap(
      await licenseApi().listDevices({ projectId: activeProject.value, includeUnbound: true })
    )
  } catch (error) {
    devices.value = []
    notice.value = { message: errorMessage(error), tone: 'danger' }
  }
}

function toggleDevice(deviceId: string): void {
  const index = selectedDeviceIds.value.indexOf(deviceId)
  if (index >= 0) {
    selectedDeviceIds.value = selectedDeviceIds.value.filter((item) => item !== deviceId)
  } else {
    selectedDeviceIds.value = [...selectedDeviceIds.value, deviceId]
  }
}

function selectAll(): void {
  selectedDeviceIds.value = activeDevices.value.map((device) => device.deviceId)
}

function clearSelection(): void {
  selectedDeviceIds.value = []
}

async function submitIssue(): Promise<void> {
  submitError.value = ''
  issued.value = []
  if (activeProject.value.length === 0) {
    submitError.value = '请先选择项目'
    return
  }
  if (selectedDeviceIds.value.length === 0) {
    submitError.value = '请选择至少一台设备'
    return
  }
  const expiresAt = localInputToUtc(expiresLocal.value)
  if (expiresLocal.value.trim().length > 0 && expiresAt === null) {
    submitError.value = '到期时间格式不合法'
    return
  }
  submitting.value = true
  try {
    const api = licenseApi()
    if (selectedDeviceIds.value.length === 1) {
      const deviceId = selectedDeviceIds.value[0] as string
      const result = unwrap(
        await api.issueLicense({
          projectId: activeProject.value,
          deviceId,
          ...(expiresAt === null ? {} : { expiresAt })
        })
      )
      issued.value = [result]
      notice.value = { message: `已签发 ${result.licenseId}`, tone: 'success' }
    } else {
      const result = unwrap(
        await api.issueLicensesBatch({
          projectId: activeProject.value,
          deviceIds: selectedDeviceIds.value,
          ...(expiresAt === null ? {} : { expiresAt })
        })
      )
      issued.value = [...result.issued]
      notice.value = { message: `批量签发成功，共 ${result.issued.length} 台`, tone: 'success' }
    }
    selectedDeviceIds.value = []
    await refreshAll()
  } catch (error) {
    submitError.value = errorMessage(error)
  } finally {
    submitting.value = false
  }
}

async function submitRenew(): Promise<void> {
  submitError.value = ''
  issued.value = []
  if (selectedDeviceIds.value.length !== 1) {
    submitError.value = '续期一次只能选择一台设备'
    return
  }
  const expiresAt = localInputToUtc(expiresLocal.value)
  if (expiresLocal.value.trim().length > 0 && expiresAt === null) {
    submitError.value = '到期时间格式不合法'
    return
  }
  submitting.value = true
  try {
    const deviceId = selectedDeviceIds.value[0] as string
    const result = unwrap(
      await licenseApi().renewLicense({
        projectId: activeProject.value,
        deviceId,
        ...(expiresAt === null ? {} : { expiresAt })
      })
    )
    issued.value = [result]
    notice.value = { message: `已续期 ${result.licenseId}`, tone: 'success' }
    selectedDeviceIds.value = []
    await refreshAll()
  } catch (error) {
    submitError.value = errorMessage(error)
  } finally {
    submitting.value = false
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

/** 多行设备 ID：去首尾空白、去空行、按首次出现顺序去重 */
function parseDeviceIds(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const deviceId = line.trim()
    if (deviceId.length === 0 || seen.has(deviceId)) {
      continue
    }
    seen.add(deviceId)
    result.push(deviceId)
  }
  return result
}

const registerSummary = computed(() => {
  const created = registerResults.value.filter((item) => item.status === 'created').length
  const existing = registerResults.value.filter((item) => item.status === 'exists').length
  const failed = registerResults.value.filter((item) => item.status === 'failed')
  return { created, existing, failed: failed.length, failures: failed }
})

/**
 * 逐台登记：一台失败不阻断其他设备；已在本项目登记的设备不再发请求（避免重复请求与额度误判）。
 * 校验语义完全由业务层决定，前端只做格式预检与结果归纳。
 */
async function submitRegister(): Promise<void> {
  registerError.value = ''
  registerResults.value = []
  const projectId = activeProject.value
  if (projectId.length === 0) {
    registerError.value = '请先选择项目'
    return
  }
  const deviceIds = parseDeviceIds(registerForm.value.deviceId)
  if (deviceIds.length === 0) {
    registerError.value = '请至少输入一个设备 ID（每行一个）'
    return
  }
  registering.value = true
  const results: RegisterResult[] = []
  try {
    const api = licenseApi()
    for (const deviceId of deviceIds) {
      if (!ID_PATTERN.test(deviceId)) {
        results.push({
          deviceId,
          status: 'failed',
          message: '设备 ID 只能包含字母、数字、点、下划线、冒号和短横线，长度 1–128'
        })
        continue
      }
      const known = devices.value.some((device) => device.deviceId === deviceId && device.unbindAt === null)
      if (known) {
        results.push({ deviceId, status: 'exists', message: '该项目已登记，未重复请求' })
        continue
      }
      try {
        unwrap(await api.registerDevice({ projectId, deviceId }))
        results.push({ deviceId, status: 'created', message: '' })
      } catch (error) {
        results.push({ deviceId, status: 'failed', message: errorMessage(error) })
      }
    }
  } finally {
    registering.value = false
  }
  registerResults.value = results
  const created = results.filter((item) => item.status === 'created').length
  const existing = results.filter((item) => item.status === 'exists').length
  const failed = results.filter((item) => item.status === 'failed').length
  if (failed === 0) {
    notice.value = { message: `登记完成：新增 ${created} 台，已存在 ${existing} 台`, tone: 'success' }
    registerForm.value.deviceId = ''
  } else if (created + existing === 0) {
    notice.value = { message: `登记失败：${failed} 台全部未成功，请查看下方逐条原因`, tone: 'danger' }
  } else {
    notice.value = {
      message: `部分成功：新增 ${created} 台，已存在 ${existing} 台，失败 ${failed} 台（失败设备保留在输入框中）`,
      tone: 'danger'
    }
  }
  await refreshAll()
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
    await refreshAll()
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
    await refreshAll()
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

async function pickCertificateFile(): Promise<void> {
  certificateError.value = ''
  try {
    const text = unwrap(await licenseApi().pickControlCertificateFile())
    if (text !== null) {
      certificateText.value = text
    }
  } catch (error) {
    certificateError.value = errorMessage(error)
  }
}

async function submitCertificate(): Promise<void> {
  certificateError.value = ''
  if (certificateText.value.trim().length === 0) {
    certificateError.value = '请粘贴或选择中控证书内容'
    return
  }
  importingCertificate.value = true
  try {
    const imported = unwrap(await licenseApi().importControlCertificate(certificateText.value))
    certificate.value = imported
    lastCertificate.value = imported
    certificateText.value = ''
    showCertificateImport.value = false
    notice.value = { message: `已导入中控证书 ${imported.licenseId}`, tone: 'success' }
    // 证书导入成功 ≠ 项目就绪：初始化结果单独呈现
    await initializeProjectsFromCertificate(imported)
    await refreshAll()
  } catch (error) {
    certificateError.value = errorMessage(error)
  } finally {
    importingCertificate.value = false
  }
}

/**
 * 用已验签证书里的 project_ids 自动初始化项目记录（只创建缺失的，不覆盖已有名称/状态）。
 * - 通配符 "*" 无法推断具体项目，保留手工输入流程；
 * - 失败逐条记录并显示项目 ID 与原因，不伪装成初始化完成；
 * - 只调用现有 createProject，不新增 IPC、不改数据库结构、不推导/伪造 project_id。
 */
async function initializeProjectsFromCertificate(imported: ControlCertificateDto): Promise<void> {
  const scope = imported.projectIds
  if (scope.includes('*')) {
    projectInit.value = {
      status: 'skipped',
      created: [],
      existing: [],
      failed: [],
      reason: '证书是通配项目范围（*），无法推断具体项目 ID。请从 Godot 插件 Dock 复制项目 ID 后手工创建。'
    }
    return
  }
  projectInit.value = { status: 'running', created: [], existing: [], failed: [], reason: '' }
  const api = licenseApi()
  let current: ProjectDto[]
  try {
    current = unwrap(await api.listProjects())
  } catch (error) {
    projectInit.value = {
      status: 'failed',
      created: [],
      existing: [],
      failed: scope.map((projectId) => ({ projectId, message: `读取项目列表失败：${errorMessage(error)}` })),
      reason: ''
    }
    return
  }
  const created: string[] = []
  const existing: string[] = []
  const failed: { projectId: string; message: string }[] = []
  for (const projectId of scope) {
    if (current.some((item) => item.projectId === projectId)) {
      existing.push(projectId)
      continue
    }
    try {
      const project = unwrap(await api.createProject({ projectId, name: projectId }))
      current = [...current, project]
      created.push(projectId)
    } catch (error) {
      failed.push({ projectId, message: errorMessage(error) })
    }
  }
  projectInit.value = {
    status: failed.length === 0 ? 'done' : created.length === 0 ? 'failed' : 'partial',
    created,
    existing,
    failed,
    reason: ''
  }
  if (failed.length > 0) {
    notice.value = {
      message: `证书已导入，但项目初始化失败 ${failed.length} 个：${failed
        .map((item) => item.projectId)
        .join('、')}（此时还不能签发，请按下方原因处理后手工创建）`,
      tone: 'danger'
    }
  }
}

async function submitPrivateKey(): Promise<void> {
  privateKeyError.value = ''
  if (privateKeyText.value.trim().length === 0) {
    privateKeyError.value = '请粘贴委托私钥 PEM 内容'
    return
  }
  importingKey.value = true
  try {
    const status = unwrap(await licenseApi().importDelegatedKey(privateKeyText.value))
    delegatedKey.value = status
    privateKeyText.value = ''
    showKeyImport.value = false
    notice.value = { message: '委托私钥已保存到本机密钥目录', tone: 'success' }
  } catch (error) {
    privateKeyError.value = errorMessage(error)
  } finally {
    importingKey.value = false
  }
}

function licenseFilePath(license: LicenseDto): string {
  return userDataPath.value.length === 0 ? license.fileName : `${userDataPath.value}/licenses/${license.fileName}`
}

onMounted(async () => {
  try {
    const info = await appApi().getAppInfo()
    userDataPath.value = info.userDataPath
  } catch {
    userDataPath.value = ''
  }
  await refreshAll()
})
</script>

<template>
  <section class="page">
    <PageHeader
      title="授权管理"
      description="三步走：导入中控证书 → 登记设备 → 签发授权。证书一次性使用，签发成功后即作废。"
    >
      <template #actions>
        <button type="button" class="btn" :disabled="loading" @click="refreshAll">刷新</button>
      </template>
    </PageHeader>

    <NoticeBanner
      v-if="notice !== null"
      :message="notice.message"
      :tone="notice.tone"
      @dismiss="notice = null"
    />

    <ol class="steps">
      <li class="steps__item" :class="{ 'steps__item--done': certificate !== null }">
        <span class="steps__index">1</span>
        <div>
          <strong>导入中控证书</strong>
          <p class="hint">厂商用私钥签发后交给你；导入时会重新验签，过期证书直接被拒。</p>
        </div>
        <StatusBadge
          :tone="certificate !== null ? 'ok' : certificateConsumed ? 'warn' : 'muted'"
          :text="certificate !== null ? '已导入' : certificateConsumed ? '已作废' : '未导入'"
        />
      </li>
      <li class="steps__item" :class="{ 'steps__item--done': activeDevices.length > 0 }">
        <span class="steps__index">2</span>
        <div>
          <strong>登记设备</strong>
          <p class="hint">设备 ID 从 Godot 插件 Dock 复制；额度与范围由当前证书决定。</p>
        </div>
        <StatusBadge :tone="activeDevices.length > 0 ? 'ok' : 'muted'" :text="`${activeDevices.length} 台`" />
      </li>
      <li class="steps__item" :class="{ 'steps__item--done': issued.length > 0 }">
        <span class="steps__index">3</span>
        <div>
          <strong>签发授权</strong>
          <p class="hint">勾选设备一键签发；成功后证书作废，需导入新证书才能再签。</p>
        </div>
        <StatusBadge :tone="issued.length > 0 ? 'ok' : 'muted'" :text="issued.length > 0 ? '已签发' : '未签发'" />
      </li>
    </ol>

    <div class="stat-row">
      <div class="stat">
        <span class="stat__label">厂商公钥</span>
        <strong class="stat__value">
          <StatusBadge
            :tone="vendorKey?.configured === true ? 'ok' : 'danger'"
            :text="vendorKey?.configured === true ? '已配置' : '未配置'"
          />
        </strong>
        <span v-if="vendorKey?.configured === false" class="hint">当前构建不能验证任何中控证书</span>
      </div>
      <div class="stat">
        <span class="stat__label">中控证书</span>
        <strong class="stat__value mono">{{ certificate?.licenseId ?? '未导入' }}</strong>
        <span v-if="certificate !== null" class="hint">
          到期 {{ formatDateTime(certificate.expiresAt) }}
          <StatusBadge v-if="certificateExpired" tone="danger" text="已过期" />
        </span>
        <span v-else-if="certificateConsumed" class="hint">
          {{ lastCertificate?.licenseId }} 已作废（一次性证书）
        </span>
      </div>
      <div class="stat">
        <span class="stat__label">设备额度</span>
        <strong class="stat__value">{{ quotaText }}</strong>
        <StatusBadge v-if="quotaExhausted" tone="warn" text="额度已用尽" />
      </div>
      <div class="stat">
        <span class="stat__label">委托私钥</span>
        <strong class="stat__value">
          <StatusBadge
            :tone="delegatedKey?.configured === true ? (delegatedKey.matchesControl === false ? 'danger' : 'ok') : 'warn'"
            :text="
              delegatedKey?.configured !== true
                ? '未配置'
                : delegatedKey.matchesControl === false
                  ? '与证书不匹配'
                  : '已配置'
            "
          />
        </strong>
        <span class="hint mono">{{ delegatedKey?.location ?? 'keys/delegated.key.pem' }}</span>
      </div>
    </div>

    <p v-if="certificateConsumed" class="form-error">
      中控证书 {{ lastCertificate?.licenseId }} 已随签发作废：请导入新的中控证书后才能继续签发（已签发的授权不受影响）。
    </p>

    <div class="card">
      <div class="card__title">
        <h3>① 中控证书</h3>
        <button type="button" class="btn btn--ghost" @click="showCertificateImport = true">
          {{ certificate === null ? '导入证书' : '更换证书' }}
        </button>
      </div>
      <dl v-if="certificate !== null" class="detail-list detail-list--grid">
        <dt>证书 ID</dt>
        <dd class="mono">{{ certificate.licenseId }}</dd>
        <dt>签发 / 到期</dt>
        <dd>{{ formatDateTime(certificate.issuedAt) }} → {{ formatDateTime(certificate.expiresAt) }}</dd>
        <dt>最大设备数</dt>
        <dd>{{ certificate.maxDevices }}</dd>
        <dt>项目范围</dt>
        <dd>{{ scopeLabel }}</dd>
        <dt>证书指纹</dt>
        <dd class="mono ellipsis">{{ certificate.kid }}</dd>
        <dt>导入时间</dt>
        <dd>{{ formatDateTime(certificate.importedAt) }}</dd>
      </dl>
      <p v-else class="hint">
        尚未导入中控证书。证书由厂商用私钥离线签发（厂商私钥不进现场），导入后才能登记设备与签发授权。
      </p>
      <p class="hint">
        委托私钥：
        <button type="button" class="btn btn--ghost" @click="showKeyImport = true">
          {{ delegatedKey?.configured === true ? '替换私钥' : '导入私钥' }}
        </button>
      </p>

      <div v-if="projectInit.status !== 'idle'" class="init-state">
        <p v-if="projectInit.status === 'running'" class="hint">正在按证书项目范围初始化项目…</p>
        <template v-else-if="projectInit.status === 'done'">
          <p class="hint">
            项目初始化完成：新建 {{ projectInit.created.length }} 个，已存在
            {{ projectInit.existing.length }} 个。
          </p>
        </template>
        <template v-else-if="projectInit.status === 'partial'">
          <p class="form-error">
            项目初始化部分完成：新建 {{ projectInit.created.length }} 个，已存在
            {{ projectInit.existing.length }} 个，失败 {{ projectInit.failed.length }} 个。失败项目尚未就绪，暂不能对其登记设备或签发。
          </p>
        </template>
        <template v-else-if="projectInit.status === 'failed'">
          <p class="form-error">
            项目初始化失败：证书已导入，但 {{ projectInit.failed.length }} 个项目都没有创建成功，此时还不能签发。
          </p>
        </template>
        <template v-else-if="projectInit.status === 'skipped'">
          <p class="hint">{{ projectInit.reason }}</p>
        </template>
        <ul v-if="projectInit.failed.length > 0" class="init-state__list">
          <li v-for="item in projectInit.failed" :key="item.projectId" class="mono">
            {{ item.projectId }}：{{ item.message }}
          </li>
        </ul>
        <p v-if="projectInit.created.length > 0" class="hint mono">
          已创建：{{ projectInit.created.join('、') }}
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card__title">
        <h3>② 项目与设备</h3>
        <span class="hint">project_id 必须与 Godot 插件 Dock 显示的值一致</span>
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
      <p v-if="projects.length > 0" class="hint">
        现有项目：
        <span v-for="project in projects" :key="project.projectId" class="chip mono">
          {{ project.name }}（{{ project.projectId }}）
          <StatusBadge
            :tone="inScope(project.projectId) ? 'ok' : 'warn'"
            :text="inScope(project.projectId) ? '在范围' : '不在范围'"
          />
          <button type="button" class="btn btn--ghost" @click="startEdit(project)">改名</button>
        </span>
      </p>

      <div class="form-grid">
        <label class="field">
          <span>设备 ID（每行一个，可从子机插件 Dock 批量复制）</span>
          <textarea
            v-model="registerForm.deviceId"
            rows="3"
            placeholder="每行一个设备 ID，例如&#10;DEV-1a2b3c4d5e6f7788&#10;DEV-9a8b7c6d5e4f3210"
          />
        </label>
        <div class="field field--action">
          <button
            type="button"
            class="btn btn--primary"
            :disabled="registering || quotaExhausted || activeProject.length === 0"
            @click="submitRegister"
          >
            {{ registering ? '登记中…' : '登记到当前项目' }}
          </button>
        </div>
      </div>
      <p class="hint">空行与重复 ID 会自动忽略；一台失败不影响其他设备，已存在的设备不会重复请求。</p>
      <p v-if="registerError.length > 0" class="form-error">{{ registerError }}</p>

      <div v-if="registerResults.length > 0" class="init-state">
        <p class="hint">
          本次登记：新增 {{ registerSummary.created }} 台，已存在 {{ registerSummary.existing }} 台，失败
          {{ registerSummary.failed }} 台。
        </p>
        <ul class="init-state__list">
          <li v-for="item in registerResults" :key="item.deviceId">
            <StatusBadge
              :tone="item.status === 'created' ? 'ok' : item.status === 'exists' ? 'muted' : 'danger'"
              :text="item.status === 'created' ? '已登记' : item.status === 'exists' ? '已存在' : '失败'"
            />
            <span class="mono">{{ item.deviceId }}</span>
            <span v-if="item.message.length > 0" class="hint">— {{ item.message }}</span>
          </li>
        </ul>
      </div>

      <p v-if="activeDevices.length === 0" class="hint">
        当前项目还没有已登记且未解绑的设备。
      </p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>设备 ID</th>
            <th>登记时间</th>
            <th>状态</th>
            <th>解绑时间</th>
            <th class="table__actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="device in activeDevices" :key="device.deviceId">
            <td class="mono">{{ device.deviceId }}</td>
            <td>{{ formatDateTime(device.registeredAt) }}</td>
            <td><StatusBadge :tone="deviceTone(device)" :text="deviceState(device)" /></td>
            <td>{{ formatDateTime(device.unbindAt) }}</td>
            <td class="table__actions">
              <button type="button" class="btn btn--ghost" @click="openStatus(device)">授权状态</button>
              <button
                type="button"
                class="btn btn--ghost"
                :disabled="locking === `${device.projectId}/${device.deviceId}`"
                @click="toggleLock(device)"
              >
                {{ device.locked ? '解锁' : '锁定' }}
              </button>
              <button type="button" class="btn btn--danger" @click="startUnbind(device)">解绑</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card__title">
        <h3>③ 签发授权</h3>
        <span class="hint">批量签发采用全批成功策略：任一设备不满足条件则整批不落库、不落文件</span>
      </div>

      <p v-if="issuanceBlockReason.length > 0" class="form-error">{{ issuanceBlockReason }}</p>

      <div class="form-grid">
        <label class="field">
          <span>项目</span>
          <select v-model="activeProject" :disabled="projects.length === 0">
            <option v-if="projects.length === 0" value="">请先创建项目</option>
            <option v-for="project in projects" :key="project.projectId" :value="project.projectId">
              {{ project.name }}（{{ project.projectId }}）
            </option>
          </select>
        </label>
        <label class="field">
          <span>到期时间（留空使用默认有效期）</span>
          <input v-model="expiresLocal" type="datetime-local" />
        </label>
      </div>

      <div class="device-picker">
        <div class="device-picker__head">
          <span>选择设备（{{ selectedDeviceIds.length }} / {{ activeDevices.length }}）</span>
          <div>
            <button type="button" class="btn btn--ghost" @click="selectAll">全选</button>
            <button type="button" class="btn btn--ghost" @click="clearSelection">清空</button>
          </div>
        </div>
        <ul v-if="activeDevices.length > 0" class="device-picker__list">
          <li v-for="device in activeDevices" :key="device.deviceId">
            <label class="checkbox">
              <input
                type="checkbox"
                :checked="selectedDeviceIds.includes(device.deviceId)"
                @change="toggleDevice(device.deviceId)"
              />
              <span class="mono">{{ device.deviceId }}</span>
              <StatusBadge v-if="device.locked" tone="warn" text="已锁定" />
            </label>
          </li>
        </ul>
      </div>

      <div class="actions-row">
        <button
          type="button"
          class="btn btn--primary"
          :disabled="submitting || !canIssue || selectedDeviceIds.length === 0"
          @click="submitIssue"
        >
          {{ submitting ? '处理中…' : selectedDeviceIds.length > 1 ? `批量签发 ${selectedDeviceIds.length} 台` : '签发授权' }}
        </button>
        <button
          type="button"
          class="btn"
          :disabled="submitting || !canIssue || selectedDeviceIds.length !== 1"
          @click="submitRenew"
        >
          续期选中设备
        </button>
      </div>
      <p v-if="submitError.length > 0" class="form-error">{{ submitError }}</p>

      <div v-if="issued.length > 0" class="result">
        <h4>签发结果</h4>
        <table class="table table--compact">
          <thead>
            <tr>
              <th>授权 ID</th>
              <th>设备</th>
              <th>到期</th>
              <th>中控实际生成的文件</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="license in issued" :key="license.licenseId">
              <td class="mono">{{ license.licenseId }}</td>
              <td class="mono">{{ license.deviceId }}</td>
              <td>{{ formatDateTime(license.expiresAt) }}</td>
              <td class="mono break">{{ licenseFilePath(license) }}</td>
            </tr>
          </tbody>
        </table>
        <div class="delivery">
          <h5>交付到子机（三步）</h5>
          <ol>
            <li>
              中控实际生成的是 <span class="mono">MCH-*.json</span>（容器 JSON：
              <span class="mono">{"v":1,"license":…,"control":…}</span>），已内嵌中控证书，不需要再单独分发
              <span class="mono">control.cert</span>。
            </li>
            <li>
              复制该文件到子机，并<strong>重命名为 <span class="mono">license.dat</span></strong>——插件只认这个文件名。
            </li>
            <li>
              放置位置：Godot 编辑器里放在<strong>工程根目录</strong>（<span class="mono">res://license.dat</span>）；
              导出后的程序放在 <strong>exe 同目录</strong>（<span class="mono">license.dat</span> 与 exe 并列）。
            </li>
          </ol>
          <p class="hint">
            证书已随本次签发作废（一次性证书），下次签发请先导入新证书；已签发的授权文件不受影响。
          </p>
        </div>
      </div>
    </div>

    <ModalDialog :open="showCertificateImport" title="导入中控授权证书" width="720px" @close="showCertificateImport = false">
      <div class="form-grid form-grid--single">
        <p class="hint">
          粘贴厂商签发的 vendor-control 信封（JSON），或从文件选择。导入时会用内置厂商公钥重新验签，
          签名或有效期不通过不会写入数据库。
        </p>
        <label class="field">
          <span>证书内容</span>
          <textarea v-model="certificateText" rows="10" placeholder='{"aegis":"license-envelope",...}' />
        </label>
        <p v-if="certificateError.length > 0" class="form-error">{{ certificateError }}</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="pickCertificateFile">从文件选择…</button>
        <button type="button" class="btn" @click="showCertificateImport = false">取消</button>
        <button type="button" class="btn btn--primary" :disabled="importingCertificate" @click="submitCertificate">
          {{ importingCertificate ? '导入中…' : '导入证书' }}
        </button>
      </template>
    </ModalDialog>

    <ModalDialog :open="showKeyImport" title="导入委托签发私钥" width="720px" @close="showKeyImport = false">
      <div class="form-grid form-grid--single">
        <p class="form-error">
          私钥只保存在本机 {{ delegatedKey?.location ?? 'keys/delegated.key.pem' }}（权限 0600），不会写入数据库、日志或构建产物；
          Windows 下仍可能被有权限的用户提取，这是已知限制。
        </p>
        <label class="field">
          <span>私钥 PEM（RSA 2048）</span>
          <textarea v-model="privateKeyText" rows="10" placeholder="粘贴 PEM 格式的 RSA 2048 私钥内容" />
        </label>
        <p v-if="privateKeyError.length > 0" class="form-error">{{ privateKeyError }}</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="showKeyImport = false">取消</button>
        <button type="button" class="btn btn--primary" :disabled="importingKey" @click="submitPrivateKey">
          {{ importingKey ? '导入中…' : '导入私钥' }}
        </button>
      </template>
    </ModalDialog>

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
