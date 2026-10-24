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
import type { HubStatusDto } from '@shared/license/hub-contract'
import type { DeviceRequestDto } from '@shared/license/delivery-contract'
import NoticeBanner from '@renderer/components/NoticeBanner.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import ModalDialog from '@renderer/components/ModalDialog.vue'
import { appApi, errorMessage, hubApi, licenseApi, unwrap } from '@renderer/lib/api'
import {
  daysUntil,
  fileCheckLabel,
  fileCheckOk,
  formatDateTime,
  localInputToUtc,
  LICENSE_STATUS_LABEL
} from '@renderer/lib/format'

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
/** 与业务层一致：30 天内到期视为「即将到期」，只影响展示，不改变授权是否有效 */
const EXPIRING_DAYS = 30

/** 证书导入后的项目初始化结果与被系统一状态机（与"证书是否导入成功"分开呈现） */
type ProjectInitStatus = 'idle' | 'running' | 'done' | 'partial' | 'failed' | 'skipped'

interface ProjectInitState {
  readonly status: ProjectInitStatus
  readonly created: readonly string[]
  readonly existing: readonly string[]
  readonly failed: readonly { readonly projectId: string; readonly message: string }[]
  readonly reason: string
}

/** 多行登记的单台结果：成功 / 已存在（不重复请求）/ 失败 */
interface RegisterResult {
  readonly deviceId: string
  readonly status: 'created' | 'exists' | 'failed'
  readonly message: string
}

/** 设备行：设备 + 当前授权 + 到期状态；projectId 隐式携带，服务调用时使用 */
interface DeviceRow {
  readonly key: string
  readonly device: DeviceDto
  readonly license: LicenseDto | null
  readonly daysLeft: number | null
  readonly state: 'unsigned' | 'expired' | 'expiring' | 'valid'
}

/** 一次签发/续期里某个归属项目的执行结果（跨项目批量时按项目分别调用） */
interface ProjectOutcome {
  readonly projectId: string
  readonly issued: readonly LicenseDto[]
  readonly error: string | null
}

const projects = ref<ProjectDto[]>([])
/** 全部项目的设备与授权：设备中心列表跨项目聚合，不再按项目切换 */
const devices = ref<DeviceDto[]>([])
const licenses = ref<LicenseDto[]>([])
const certificate = ref<ControlCertificateDto | null>(null)
const lastCertificate = ref<ControlCertificateDto | null>(null)
const quota = ref<QuotaUsageDto | null>(null)
const vendorKey = ref<VendorKeyStatusDto | null>(null)
const delegatedKey = ref<DelegatedKeyStatusDto | null>(null)
const userDataPath = ref('')
const loading = ref(false)
const notice = ref<{ message: string; tone: 'danger' | 'success' | 'info' } | null>(null)

/** 登记设备时使用的归属项目（证书唯一项目时自动填充，多项目/通配时由操作员确定） */
const registerProjectId = ref('')
const selectedKeys = ref<string[]>([])
const expiresLocal = ref('')
const submitting = ref(false)
const submitError = ref('')
const issued = ref<LicenseDto[]>([])
const issueErrors = ref<{ readonly projectId: string; readonly message: string }[]>([])

const addProjectForm = ref({ projectId: '', name: '' })
const addProjectError = ref('')
const addingProject = ref(false)
const showAddProject = ref(false)

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
const setupExpanded = ref(false)
const locking = ref<string | null>(null)
const unbinding = ref<DeviceDto | null>(null)
const unbindReason = ref('')
const unbindError = ref('')
const unbindBusy = ref(false)
const statusTarget = ref<DeviceDto | null>(null)
const statusDetail = ref<DeviceLicenseStatusDto | null>(null)
const statusHistory = ref<LicenseDto[]>([])
const statusError = ref('')
const statusLoading = ref(false)

const hubStatus = ref<HubStatusDto | null>(null)
const hubRequests = ref<DeviceRequestDto[]>([])
const hubBusy = ref(false)
const hubError = ref('')

const certificateText = ref('')
const certificateError = ref('')
const importingCertificate = ref(false)
const showCertificateImport = ref(false)
const privateKeyText = ref('')
const privateKeyError = ref('')
const importingKey = ref(false)
const showKeyImport = ref(false)

function keyOf(projectId: string, deviceId: string): string {
  return `${projectId}/${deviceId}`
}

/** 证书已过期（导入时即被拒绝，这里兜底展示） */
const certificateExpired = computed(() => {
  if (certificate.value === null) {
    return false
  }
  const days = daysUntil(certificate.value.expiresAt)
  return days !== null && days <= 0
})

/** 历史一次性规则遗留：没有生效证书，但最近导入过一张且已作废 */
const certificateConsumed = computed(
  () => certificate.value === null && lastCertificate.value !== null && !lastCertificate.value.isActive
)

const scopeLabel = computed(() => {
  if (certificate.value === null) {
    return '未导入中控证书'
  }
  const ids = certificate.value.projectIds
  return ids.includes('*') ? '全部工程' : ids.join('、')
})

const scopeIsWildcard = computed(() => certificate.value?.projectIds.includes('*') === true)
/** 证书范围里的具体项目 ID（通配时为空数组） */
const scopeProjectIds = computed<readonly string[]>(() => {
  const cert = certificate.value
  if (cert === null || cert.projectIds.includes('*')) {
    return []
  }
  return cert.projectIds
})
/** 单项目证书：设备归属完全隐式，界面不出现任何项目选择 */
const scopeIsSingle = computed(() => scopeProjectIds.value.length === 1)
/** 多项目证书：登记时必须确定归属（不能靠猜） */
const needsOwnerChoice = computed(() => certificate.value !== null && !scopeIsSingle.value)

function inScope(projectId: string): boolean {
  if (certificate.value === null) {
    return false
  }
  const ids = certificate.value.projectIds
  return ids.includes('*') || ids.includes(projectId)
}

/** 归属下拉的可选项目：只列出证书范围内且已建立关联的项目 */
const allowedProjectIds = computed<string[]>(() => {
  const cert = certificate.value
  if (cert === null) {
    return []
  }
  if (cert.projectIds.includes('*')) {
    return projects.value.map((item) => item.projectId)
  }
  return cert.projectIds.filter((projectId) => projects.value.some((item) => item.projectId === projectId))
})

const registrationProjectInScope = computed(() => {
  const projectId = registerProjectId.value.trim()
  return projectId.length > 0 && inScope(projectId)
})

const quotaText = computed(() => {
  if (quota.value === null) {
    return '不可用（需要生效中控证书）'
  }
  return `${quota.value.usedDevices} / ${quota.value.maxDevices}`
})

const quotaExhausted = computed(
  () => quota.value !== null && quota.value.usedDevices >= quota.value.maxDevices
)

const vendorReady = computed(() => vendorKey.value?.configured === true)
const delegatedReady = computed(
  () => delegatedKey.value?.configured === true && delegatedKey.value.matchesControl !== false
)

/** 首次配置是否完整：只有这里为 true 才允许签发 */
const configReady = computed(
  () => vendorReady.value && certificate.value !== null && !certificateExpired.value && delegatedReady.value
)

const canIssue = computed(() => configReady.value)

const issuanceBlockReason = computed(() => {
  if (vendorKey.value !== null && !vendorKey.value.configured) {
    return '当前构建未配置厂商公钥，无法验证中控证书，也不能签发'
  }
  if (certificateConsumed.value) {
    return '该中控证书已被作废（历史一次性规则遗留），请导入新证书后再签发'
  }
  if (certificate.value === null) {
    return '尚未导入中控授权证书：先导入厂商签发的中控证书'
  }
  if (certificateExpired.value) {
    return '中控证书已过期，不能继续签发'
  }
  if (delegatedKey.value === null || !delegatedKey.value.configured) {
    return '本机未配置委托签发私钥：导入后才能签发'
  }
  if (delegatedKey.value.matchesControl === false) {
    return '委托私钥与中控证书不匹配，请导入与该证书配对的私钥'
  }
  return ''
})

/** 配置不完整或项目初始化失败时必须展开首次配置区，避免把需要处理的错误折叠隐藏 */
const setupAttention = computed(
  () =>
    !configReady.value ||
    projectInit.value.status === 'failed' ||
    projectInit.value.status === 'partial'
)

/** 未解绑设备：设备中心的核心管理对象 */
const activeDevices = computed(() => devices.value.filter((device) => device.unbindAt === null))

/**
 * 当前授权判定与业务层 findCurrentLicense 语义一致：
 * status=active、file_state=written、superseded_by 为空；同一设备只取最新一条。
 */
function buildCurrentLicenseMap(list: readonly LicenseDto[]): Map<string, LicenseDto> {
  const map = new Map<string, LicenseDto>()
  for (const license of list) {
    if (license.status !== 'active' || license.fileState !== 'written' || license.supersededBy !== null) {
      continue
    }
    const key = keyOf(license.projectId, license.deviceId)
    const existing = map.get(key)
    if (existing === undefined || license.issuedAt > existing.issuedAt) {
      map.set(key, license)
    }
  }
  return map
}

const currentLicenses = computed(() => buildCurrentLicenseMap(licenses.value))

function licenseStateOf(license: LicenseDto | null): DeviceRow['state'] {
  if (license === null) {
    return 'unsigned'
  }
  const days = daysUntil(license.expiresAt)
  if (days === null) {
    return 'valid'
  }
  if (days <= 0) {
    return 'expired'
  }
  return days <= EXPIRING_DAYS ? 'expiring' : 'valid'
}

const deviceRows = computed<DeviceRow[]>(() => {
  const rows: DeviceRow[] = activeDevices.value.map((device) => {
    const license = currentLicenses.value.get(keyOf(device.projectId, device.deviceId)) ?? null
    return {
      key: keyOf(device.projectId, device.deviceId),
      device,
      license,
      daysLeft: license === null ? null : daysUntil(license.expiresAt),
      state: licenseStateOf(license)
    }
  })
  // 排序：已过期 → 即将到期 → 正常（都按剩余天数升序）→ 未签发
  return rows.sort((a, b) => {
    const rank = (row: DeviceRow): number => (row.state === 'unsigned' ? 2 : row.state === 'valid' ? 1 : 0)
    const diff = rank(a) - rank(b)
    if (diff !== 0) {
      return diff
    }
    if (a.daysLeft !== null && b.daysLeft !== null && a.daysLeft !== b.daysLeft) {
      return a.daysLeft - b.daysLeft
    }
    if (a.device.projectId !== b.device.projectId) {
      return a.device.projectId.localeCompare(b.device.projectId)
    }
    return a.device.deviceId.localeCompare(b.device.deviceId)
  })
})

/** 统一状态徽标：有效 / 即将到期 / 已过期 / 未签发 */
function licenseBadge(row: DeviceRow): { tone: 'ok' | 'warn' | 'danger' | 'muted'; text: string } {
  switch (row.state) {
    case 'unsigned':
      return { tone: 'muted', text: '未签发' }
    case 'expired':
      return { tone: 'danger', text: '已过期' }
    case 'expiring':
      return { tone: 'warn', text: '即将到期' }
    default:
      return { tone: 'ok', text: '有效' }
  }
}

function daysText(row: DeviceRow): string {
  if (row.state === 'unsigned' || row.daysLeft === null) {
    return '—'
  }
  return row.daysLeft <= 0 ? '已过期' : `剩 ${row.daysLeft} 天`
}

/** 归属列只在确实存在多个工程的设备时出现，单场馆单工程时不占版面 */
const showOwnerColumn = computed(
  () => new Set(activeDevices.value.map((device) => device.projectId)).size > 1
)

function ownerLabel(projectId: string): string {
  const project = projects.value.find((item) => item.projectId === projectId)
  return project === undefined ? projectId : project.name
}

const summary = computed(() => {
  const rows = deviceRows.value
  return {
    devices: rows.length,
    valid: rows.filter((row) => row.state === 'valid' || row.state === 'expiring').length,
    expiring: rows.filter((row) => row.state === 'expiring').length,
    expired: rows.filter((row) => row.state === 'expired').length,
    unsigned: rows.filter((row) => row.state === 'unsigned').length
  }
})

const allSelected = computed(
  () => deviceRows.value.length > 0 && selectedKeys.value.length === deviceRows.value.length
)

const selectedRows = computed(() => deviceRows.value.filter((row) => selectedKeys.value.includes(row.key)))

/** 多台续期只对"已有当前授权"的设备开放，未授权设备应使用批量签发 */
const renewBlockReason = computed(() => {
  if (selectedRows.value.length <= 1) {
    return ''
  }
  const missing = selectedRows.value.filter((row) => row.license === null).map((row) => row.device.deviceId)
  if (missing.length === 0) {
    return ''
  }
  return `以下设备没有可续期的当前授权，请改用「批量签发」：${missing.join('、')}`
})

const renewDisabled = computed(
  () =>
    submitting.value ||
    !canIssue.value ||
    selectedKeys.value.length === 0 ||
    selectedRows.value.length !== selectedKeys.value.length ||
    selectedRows.value.some((row) => row.license === null)
)

function toggleDevice(key: string): void {
  selectedKeys.value = selectedKeys.value.includes(key)
    ? selectedKeys.value.filter((item) => item !== key)
    : [...selectedKeys.value, key]
}

function onToggleAll(event: Event): void {
  const target = event.target as HTMLInputElement | null
  if (target === null) {
    return
  }
  selectedKeys.value = target.checked ? deviceRows.value.map((row) => row.key) : []
}

function clearSelection(): void {
  selectedKeys.value = []
}

/** 选中设备按归属项目分组：服务层的批量签发只接受单一 projectId */
function groupSelected(): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const row of selectedRows.value) {
    const list = groups.get(row.device.projectId) ?? []
    list.push(row.device.deviceId)
    groups.set(row.device.projectId, list)
  }
  return groups
}

async function refreshAll(): Promise<void> {
  loading.value = true
  try {
    const api = licenseApi()
    const [projectList, controlResult, lastResult, quotaResult, vendorResult, keyResult, deviceList, licenseList] =
      await Promise.all([
        api.listProjects(),
        api.currentControlCertificate(),
        api.lastControlCertificate(),
        api.quota(),
        api.vendorKeyStatus(),
        api.delegatedKeyStatus(),
        api.listDevices({ includeUnbound: true }),
        api.listLicenses({ limit: 1000 })
      ])
    projects.value = unwrap(projectList)
    certificate.value = unwrap(controlResult)
    lastCertificate.value = unwrap(lastResult)
    quota.value = quotaResult.ok ? quotaResult.value : null
    vendorKey.value = unwrap(vendorResult)
    delegatedKey.value = unwrap(keyResult)
    devices.value = unwrap(deviceList)
    licenses.value = unwrap(licenseList)
    selectedKeys.value = selectedKeys.value.filter((key) =>
      deviceRows.value.some((row) => row.key === key)
    )
    ensureRegisterProject()
  } catch (error) {
    notice.value = { message: errorMessage(error), tone: 'danger' }
  } finally {
    loading.value = false
  }
}

/** Hub 状态与最近通信记录（只读也可查看；启停由主进程校验管理员会话） */
async function refreshHub(): Promise<void> {
  try {
    const api = hubApi()
    const [statusResult, requestResult] = await Promise.all([
      api.status(),
      api.requests({ limit: 20 })
    ])
    hubStatus.value = unwrap(statusResult)
    hubRequests.value = unwrap(requestResult)
    hubError.value = ''
  } catch (error) {
    hubError.value = errorMessage(error)
  }
}

async function toggleHub(): Promise<void> {
  hubBusy.value = true
  hubError.value = ''
  try {
    const api = hubApi()
    const next =
      hubStatus.value?.state === 'running' ? await api.stop() : await api.start()
    hubStatus.value = unwrap(next)
    await refreshHub()
  } catch (error) {
    hubError.value = errorMessage(error)
    await refreshHub()
  } finally {
    hubBusy.value = false
  }
}

const hubStateBadge = computed<{ tone: 'ok' | 'warn' | 'danger' | 'muted'; text: string }>(() => {
  const state = hubStatus.value?.state ?? 'stopped'
  if (state === 'running') {
    return { tone: 'ok', text: '运行中' }
  }
  if (state === 'starting') {
    return { tone: 'warn', text: '启动中' }
  }
  if (state === 'error') {
    return { tone: 'danger', text: '启动失败' }
  }
  return { tone: 'muted', text: '已停止' }
})

/** 归属项目默认值：唯一时直接填；多项目时落在范围首个已建关联项目；通配时保留已填值 */
function ensureRegisterProject(): void {
  const cert = certificate.value
  if (cert === null) {
    registerProjectId.value = ''
    return
  }
  if (cert.projectIds.includes('*')) {
    if (registerProjectId.value.trim().length === 0) {
      registerProjectId.value = projects.value[0]?.projectId ?? ''
    }
    return
  }
  if (cert.projectIds.length === 1) {
    registerProjectId.value = cert.projectIds[0] ?? ''
    return
  }
  if (!cert.projectIds.includes(registerProjectId.value.trim())) {
    registerProjectId.value = allowedProjectIds.value[0] ?? cert.projectIds[0] ?? ''
  }
}

async function openAddProject(): Promise<void> {
  addProjectError.value = ''
  addProjectForm.value = { projectId: '', name: '' }
  showAddProject.value = true
}

/**
 * 手工建立项目关联：只使用现有 createProject，不推导、不猜测项目 ID。
 * 通配范围（*）时由操作员从 Godot 插件 Dock 粘贴真实项目 ID。
 */
async function submitAddProject(): Promise<void> {
  addProjectError.value = ''
  const projectId = addProjectForm.value.projectId.trim()
  const name = addProjectForm.value.name.trim()
  if (!ID_PATTERN.test(projectId)) {
    addProjectError.value = '项目 ID 只能包含字母、数字、点、下划线、冒号和短横线，长度 1–128'
    return
  }
  if (name.length === 0 || name.length > 128) {
    addProjectError.value = '项目名称长度必须为 1–128'
    return
  }
  if (projects.value.some((item) => item.projectId === projectId)) {
    addProjectError.value = `项目 ID ${projectId} 已存在`
    return
  }
  addingProject.value = true
  try {
    const created = unwrap(await licenseApi().createProject({ projectId, name }))
    projects.value = [...projects.value, created].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    registerProjectId.value = created.projectId
    showAddProject.value = false
    if (!inScope(created.projectId)) {
      notice.value = {
        message: `已建立归属 ${created.projectId}，但它不在当前中控证书范围内，登记与签发都会被拒绝`,
        tone: 'info'
      }
    } else {
      notice.value = { message: `已建立归属 ${created.projectId}`, tone: 'success' }
    }
    await refreshAll()
  } catch (error) {
    addProjectError.value = errorMessage(error)
  } finally {
    addingProject.value = false
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

/** 归属关联不存在时按现有 createProject 建立（操作员只提供真实项目 ID，系统不猜） */
async function ensureProjectRecord(projectId: string): Promise<void> {
  if (projects.value.some((item) => item.projectId === projectId)) {
    return
  }
  const created = unwrap(await licenseApi().createProject({ projectId, name: projectId }))
  projects.value = [...projects.value, created]
}

/**
 * 逐台登记：一台失败不阻断其他设备；已登记的设备不再发请求。
 * 校验语义由业务层决定，前端只做格式预检与结果归纳。
 */
async function submitRegister(): Promise<void> {
  registerError.value = ''
  registerResults.value = []
  const projectId = registerProjectId.value.trim()
  if (projectId.length === 0) {
    registerError.value = '请先指定设备的归属工程 ID（从 Godot 插件 Dock 复制）'
    return
  }
  if (!inScope(projectId)) {
    registerError.value = `工程 ${projectId} 不在当前中控证书范围内，不能登记`
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
    await ensureProjectRecord(projectId)
    for (const deviceId of deviceIds) {
      if (!ID_PATTERN.test(deviceId)) {
        results.push({
          deviceId,
          status: 'failed',
          message: '设备 ID 只能包含字母、数字、点、下划线、冒号和短横线，长度 1–128'
        })
        continue
      }
      const known = devices.value.some(
        (device) => device.deviceId === deviceId && device.unbindAt === null
      )
      if (known) {
        results.push({ deviceId, status: 'exists', message: '该设备已登记，未重复请求' })
        continue
      }
      try {
        unwrap(await api.registerDevice({ projectId, deviceId }))
        results.push({ deviceId, status: 'created', message: '' })
      } catch (error) {
        results.push({ deviceId, status: 'failed', message: errorMessage(error) })
      }
    }
  } catch (error) {
    registerError.value = errorMessage(error)
  } finally {
    registering.value = false
  }
  registerResults.value = results
  const created = results.filter((item) => item.status === 'created').length
  const existing = results.filter((item) => item.status === 'exists').length
  const failed = results.filter((item) => item.status === 'failed').length
  if (results.length === 0) {
    return
  }
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

function resolvedExpiry(): { ok: boolean; value: string | null } {
  const expiresAt = localInputToUtc(expiresLocal.value)
  if (expiresLocal.value.trim().length > 0 && expiresAt === null) {
    return { ok: false, value: null }
  }
  return { ok: true, value: expiresAt }
}

/** 批量签发：按归属项目分组调用现有接口，逐组记录真实结果，不合并成一个成功提示 */
async function submitIssue(): Promise<void> {
  submitError.value = ''
  issued.value = []
  issueErrors.value = []
  if (selectedKeys.value.length === 0) {
    submitError.value = '请选择至少一台设备'
    return
  }
  const expiry = resolvedExpiry()
  if (!expiry.ok) {
    submitError.value = '到期时间格式不合法'
    return
  }
  submitting.value = true
  try {
    const api = licenseApi()
    const groups = groupSelected()
    const outcomes: ProjectOutcome[] = []
    for (const [projectId, deviceIds] of groups) {
      try {
        if (deviceIds.length === 1) {
          const result = unwrap(
            await api.issueLicense({
              projectId,
              deviceId: deviceIds[0] as string,
              ...(expiry.value === null ? {} : { expiresAt: expiry.value })
            })
          )
          outcomes.push({ projectId, issued: [result], error: null })
        } else {
          const result = unwrap(
            await api.issueLicensesBatch({
              projectId,
              deviceIds,
              ...(expiry.value === null ? {} : { expiresAt: expiry.value })
            })
          )
          outcomes.push({ projectId, issued: [...result.issued], error: null })
        }
      } catch (error) {
        outcomes.push({ projectId, issued: [], error: errorMessage(error) })
      }
    }
    applyOutcomes(outcomes, '签发')
    await refreshAll()
  } finally {
    submitting.value = false
  }
}

/**
 * 续期：单台走 renewLicense（服务层要求存在当前授权）；
 * 多台使用 issueLicensesBatch，业务层会为每台生成替代记录并把旧记录标记 superseded_by。
 * 只允许选择全部持有当前授权的设备，未授权设备应使用「批量签发」。
 */
async function submitRenew(): Promise<void> {
  submitError.value = ''
  issued.value = []
  issueErrors.value = []
  if (selectedKeys.value.length === 0) {
    submitError.value = '请选择要续期的设备'
    return
  }
  if (renewBlockReason.value.length > 0) {
    submitError.value = renewBlockReason.value
    return
  }
  const expiry = resolvedExpiry()
  if (!expiry.ok) {
    submitError.value = '到期时间格式不合法'
    return
  }
  submitting.value = true
  try {
    const api = licenseApi()
    const groups = groupSelected()
    const outcomes: ProjectOutcome[] = []
    for (const [projectId, deviceIds] of groups) {
      try {
        if (deviceIds.length === 1) {
          const result = unwrap(
            await api.renewLicense({
              projectId,
              deviceId: deviceIds[0] as string,
              ...(expiry.value === null ? {} : { expiresAt: expiry.value })
            })
          )
          outcomes.push({ projectId, issued: [result], error: null })
        } else {
          const result = unwrap(
            await api.issueLicensesBatch({
              projectId,
              deviceIds,
              ...(expiry.value === null ? {} : { expiresAt: expiry.value })
            })
          )
          outcomes.push({ projectId, issued: [...result.issued], error: null })
        }
      } catch (error) {
        outcomes.push({ projectId, issued: [], error: errorMessage(error) })
      }
    }
    applyOutcomes(outcomes, '续期')
    await refreshAll()
  } finally {
    submitting.value = false
  }
}

/** 汇总分组结果：成功台数与失败项目分别呈现，绝不把部分失败说成全部成功 */
function applyOutcomes(outcomes: readonly ProjectOutcome[], action: '签发' | '续期'): void {
  const success = outcomes.filter((item) => item.error === null)
  const failures = outcomes
    .filter((item) => item.error !== null)
    .map((item) => ({ projectId: item.projectId, message: item.error as string }))
  issued.value = success.flatMap((item) => [...item.issued])
  issueErrors.value = failures
  if (failures.length === 0) {
    notice.value = { message: `${action}成功，共 ${issued.value.length} 台`, tone: 'success' }
    return
  }
  if (issued.value.length === 0) {
    notice.value = {
      message: `${action}失败：${failures.length} 个归属工程全部未成功（逐条见下方）`,
      tone: 'danger'
    }
    return
  }
  notice.value = {
    message: `部分成功：已${action} ${issued.value.length} 台，${failures.length} 个归属工程失败（逐条见下方）`,
    tone: 'danger'
  }
}

async function toggleLock(row: DeviceRow): Promise<void> {
  locking.value = row.key
  try {
    const action = row.device.locked ? licenseApi().unlockDevice : licenseApi().lockDevice
    unwrap(await action({ projectId: row.device.projectId, deviceId: row.device.deviceId }))
    notice.value = {
      message: row.device.locked
        ? `设备 ${row.device.deviceId} 已解锁`
        : `设备 ${row.device.deviceId} 已锁定`,
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

/** 设备详情：当前授权文件实校验 + 该设备的历史授权记录（全部来自现有接口） */
async function openStatus(device: DeviceDto): Promise<void> {
  statusTarget.value = device
  statusDetail.value = null
  statusHistory.value = []
  statusError.value = ''
  statusLoading.value = true
  try {
    const api = licenseApi()
    const [statusResult, historyResult] = await Promise.all([
      api.deviceStatus({ projectId: device.projectId, deviceId: device.deviceId }),
      api.listLicenses({ deviceId: device.deviceId, limit: 50 })
    ])
    statusDetail.value = unwrap(statusResult)
    statusHistory.value = unwrap(historyResult)
  } catch (error) {
    statusError.value = errorMessage(error)
  } finally {
    statusLoading.value = false
  }
}

function historyStateLabel(license: LicenseDto): { tone: 'ok' | 'warn' | 'muted'; text: string } {
  if (license.supersededBy !== null) {
    return { tone: 'muted', text: '已被替代' }
  }
  if (license.status !== 'active') {
    return { tone: 'muted', text: '已吊销' }
  }
  if (license.fileState !== 'written') {
    return { tone: 'warn', text: '未落盘' }
  }
  const days = daysUntil(license.expiresAt)
  if (days !== null && days <= 0) {
    return { tone: 'warn', text: '已过期' }
  }
  return { tone: 'ok', text: '当前有效' }
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
    // 证书导入成功 ≠ 项目关联就绪：初始化结果单独呈现
    await initializeProjectsFromCertificate(imported, 'import')
    await refreshAll()
  } catch (error) {
    certificateError.value = errorMessage(error)
  } finally {
    importingCertificate.value = false
  }
}

/**
 * 用已验签证书里的 project_ids 自动建立底层项目关联（只创建缺失的，不覆盖已有名称）。
 * UI 不再展示项目列表，操作员也不需要手工创建；通配 "*" 无法推断具体 ID，保留录入入口。
 */
async function initializeProjectsFromCertificate(
  imported: ControlCertificateDto,
  mode: 'import' | 'auto' = 'import'
): Promise<void> {
  const scope = imported.projectIds
  if (scope.includes('*')) {
    if (mode === 'auto') {
      return
    }
    projectInit.value = {
      status: 'skipped',
      created: [],
      existing: [],
      failed: [],
      reason: '证书是通配工程范围（*），系统不能推断具体工程 ID。请从 Godot 插件 Dock 复制真实工程 ID 后填入设备归属。'
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
      failed: scope.map((projectId) => ({ projectId, message: `读取项目关联失败：${errorMessage(error)}` })),
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
  if (mode === 'auto' && created.length === 0 && failed.length === 0) {
    projectInit.value = { status: 'idle', created: [], existing: [], failed: [], reason: '' }
    return
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
      message: `工程关联初始化失败 ${failed.length} 个：${failed
        .map((item) => item.projectId)
        .join('、')}（这些工程还不能登记与签发，请按下方原因处理）`,
      tone: 'danger'
    }
  }
}

/** 进入工作台时按证书范围补齐底层工程关联；只在挂载时执行一次 */
async function autoInitProjects(): Promise<void> {
  const cert = certificate.value
  if (cert === null || !vendorReady.value || cert.projectIds.includes('*')) {
    return
  }
  const missing = cert.projectIds.filter((projectId) => !projects.value.some((item) => item.projectId === projectId))
  if (missing.length === 0) {
    return
  }
  await initializeProjectsFromCertificate(cert, 'auto')
  await refreshAll()
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
  await autoInitProjects()
  await refreshHub()
})
</script>

<template>
  <section class="page page--wide">
    <header class="page-header">
      <div>
        <h2>设备授权</h2>
        <p>
          登记子主机 → 选择设备 → 批量签发或续期。授权按设备 ID 绑定，工程归属由系统在底层维护。
          <span v-if="certificate !== null">当前证书范围：{{ scopeLabel }}。</span>
        </p>
      </div>
      <div class="page-header__actions">
        <span class="hint">设备额度 {{ quotaText }}</span>
        <StatusBadge v-if="quotaExhausted" tone="warn" text="额度已用尽" />
        <button type="button" class="btn" :disabled="loading" @click="refreshAll">刷新</button>
      </div>
    </header>

    <NoticeBanner
      v-if="notice !== null"
      :message="notice.message"
      :tone="notice.tone"
      @dismiss="notice = null"
    />

    <div class="setup" :class="{ 'setup--ready': configReady && !setupAttention }">
      <div class="setup__head">
        <div>
          <h3>首次配置</h3>
          <p class="hint">
            中控证书与委托私钥只需配置一次；日常只需要登记设备、签发或续期。
          </p>
        </div>
        <div class="setup__head-actions">
          <StatusBadge :tone="configReady ? 'ok' : 'warn'" :text="configReady ? '配置完整' : '需要配置'" />
          <button
            v-if="configReady && !setupAttention"
            type="button"
            class="btn btn--ghost"
            @click="setupExpanded = !setupExpanded"
          >
            {{ setupExpanded ? '收起配置' : '查看配置' }}
          </button>
        </div>
      </div>

      <template v-if="setupAttention || setupExpanded">
        <ol class="setup__steps">
          <li class="setup__step" :class="{ 'setup__step--done': certificate !== null && !certificateExpired }">
            <span class="setup__index">1</span>
            <div class="setup__body">
              <strong>中控证书</strong>
              <p class="hint">
                {{
                  certificate === null
                    ? certificateConsumed
                      ? '最近一张证书已被作废（历史一次性规则遗留），请导入新证书。'
                      : '尚未导入。厂商用私钥离线签发后交给你，导入时会重新验签。'
                    : `证书 ${certificate.licenseId} · 到期 ${formatDateTime(certificate.expiresAt)} · 最多 ${certificate.maxDevices} 台设备`
                }}
              </p>
            </div>
            <div class="setup__actions">
              <StatusBadge
                :tone="
                  certificate !== null && !certificateExpired
                    ? 'ok'
                    : certificateConsumed
                      ? 'warn'
                      : certificateExpired
                        ? 'danger'
                        : 'muted'
                "
                :text="
                  certificate !== null && !certificateExpired
                    ? '已导入'
                    : certificateExpired
                      ? '已过期'
                      : certificateConsumed
                        ? '已作废'
                        : '未导入'
                "
              />
              <button type="button" class="btn" @click="showCertificateImport = true">
                {{ certificate === null ? '导入证书' : '更换证书' }}
              </button>
            </div>
          </li>
          <li class="setup__step" :class="{ 'setup__step--done': delegatedReady }">
            <span class="setup__index">2</span>
            <div class="setup__body">
              <strong>委托签发私钥</strong>
              <p class="hint">
                只保存在本机 <span class="mono">{{ delegatedKey?.location ?? 'keys/delegated.key.pem' }}</span>，不写入数据库、日志或构建产物。
              </p>
            </div>
            <div class="setup__actions">
              <StatusBadge
                :tone="delegatedKey?.configured !== true ? 'warn' : delegatedKey.matchesControl === false ? 'danger' : 'ok'"
                :text="
                  delegatedKey?.configured !== true
                    ? '未配置'
                    : delegatedKey.matchesControl === false
                      ? '与证书不匹配'
                      : '已配置'
                "
              />
              <button type="button" class="btn" @click="showKeyImport = true">
                {{ delegatedKey?.configured === true ? '替换私钥' : '导入私钥' }}
              </button>
            </div>
          </li>
        </ol>

        <p v-if="issuanceBlockReason.length > 0" class="form-error">{{ issuanceBlockReason }}</p>
        <p v-else-if="quotaExhausted" class="form-error">
          设备额度已用尽：登记更多设备前需要在厂商侧签发更大的中控证书。
        </p>

        <dl v-if="setupExpanded && certificate !== null" class="detail-list detail-list--grid setup__detail">
          <dt>证书 ID</dt>
          <dd class="mono">{{ certificate.licenseId }}</dd>
          <dt>签发 / 到期</dt>
          <dd>{{ formatDateTime(certificate.issuedAt) }} → {{ formatDateTime(certificate.expiresAt) }}</dd>
          <dt>最大设备数</dt>
          <dd>{{ certificate.maxDevices }}</dd>
          <dt>工程范围</dt>
          <dd>{{ scopeLabel }}</dd>
          <dt>证书指纹</dt>
          <dd class="mono ellipsis">{{ certificate.kid }}</dd>
          <dt>导入时间</dt>
          <dd>{{ formatDateTime(certificate.importedAt) }}</dd>
        </dl>

        <div v-if="projectInit.status !== 'idle'" class="init-state">
          <p v-if="projectInit.status === 'running'" class="hint">正在按证书范围初始化工程关联…</p>
          <template v-else-if="projectInit.status === 'done'">
            <p class="hint">
              工程关联初始化完成：新建 {{ projectInit.created.length }} 个，已存在 {{ projectInit.existing.length }} 个。
            </p>
          </template>
          <template v-else-if="projectInit.status === 'partial'">
            <p class="form-error">
              工程关联部分完成：新建 {{ projectInit.created.length }} 个，已存在
              {{ projectInit.existing.length }} 个，失败 {{ projectInit.failed.length }} 个。失败工程尚未就绪，暂不能对其登记设备或签发。
            </p>
          </template>
          <template v-else-if="projectInit.status === 'failed'">
            <p class="form-error">
              工程关联初始化失败：{{ projectInit.failed.length }} 个都没有创建成功，这些工程还不能登记与签发。
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
            已建立：{{ projectInit.created.join('、') }}
          </p>
        </div>
      </template>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span class="stat__label">已登记设备</span>
        <strong class="stat__value">{{ summary.devices }}</strong>
        <span class="hint">未解绑设备计入额度</span>
      </div>
      <div class="stat">
        <span class="stat__label">有效授权</span>
        <strong class="stat__value">{{ summary.valid }}</strong>
        <span class="hint">含 30 天内到期</span>
      </div>
      <div class="stat">
        <span class="stat__label">即将到期</span>
        <strong class="stat__value">{{ summary.expiring }}</strong>
        <span class="hint">30 天内到期</span>
      </div>
      <div class="stat">
        <span class="stat__label">已过期 / 未签发</span>
        <strong class="stat__value">{{ summary.expired }} / {{ summary.unsigned }}</strong>
        <span class="hint">需要续期或签发</span>
      </div>
    </div>

    <div class="card">
      <div class="card__title">
        <h3>登记设备</h3>
        <span class="hint">设备 ID 从 Godot 插件 Dock 复制</span>
      </div>
      <div class="form-grid">
        <label v-if="needsOwnerChoice && scopeIsWildcard" class="field">
          <span>设备归属工程 ID（从插件 Dock 复制，证书为通配范围）</span>
          <input v-model="registerProjectId" list="aegis-known-projects" placeholder="例如 3f9a1c7d20" />
          <datalist id="aegis-known-projects">
            <option v-for="project in projects" :key="project.projectId" :value="project.projectId">
              {{ project.name }}
            </option>
          </datalist>
        </label>
        <label v-else-if="needsOwnerChoice" class="field">
          <span>设备归属工程</span>
          <select v-model="registerProjectId">
            <option v-for="projectId in allowedProjectIds" :key="projectId" :value="projectId">
              {{ ownerLabel(projectId) }}（{{ projectId }}）
            </option>
          </select>
        </label>
        <label class="field">
          <span>设备 ID（每行一个，支持粘贴多行）</span>
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
            :disabled="registering || quotaExhausted || !registrationProjectInScope"
            @click="submitRegister"
          >
            {{ registering ? '登记中…' : '登记设备' }}
          </button>
        </div>
      </div>
      <p class="hint">
        空行与重复 ID 会自动忽略；一台失败不影响其他设备，已存在的设备不会重复请求。
        <span v-if="scopeIsSingle && registerProjectId.length > 0">
          设备归属：<span class="mono">{{ registerProjectId }}</span>（证书唯一工程，自动填充）
        </span>
        <button
          v-if="needsOwnerChoice"
          type="button"
          class="btn btn--ghost"
          @click="openAddProject"
        >
          添加归属工程
        </button>
      </p>
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
    </div>

    <div class="card">
      <div class="card__title">
        <h3>设备与授权</h3>
        <span class="hint">已选 {{ selectedKeys.length }} / {{ deviceRows.length }} 台</span>
      </div>

      <div class="toolbar">
        <label class="field field--narrow">
          <span>统一到期时间（留空用服务默认有效期）</span>
          <input v-model="expiresLocal" type="datetime-local" />
        </label>
        <div class="toolbar__actions">
          <button type="button" class="btn btn--ghost" @click="selectedKeys = deviceRows.map((row) => row.key)">
            全选
          </button>
          <button type="button" class="btn btn--ghost" :disabled="selectedKeys.length === 0" @click="clearSelection">
            清空选择
          </button>
          <span class="toolbar__divider" />
          <button
            type="button"
            class="btn btn--primary"
            :disabled="submitting || !canIssue || selectedKeys.length === 0"
            @click="submitIssue"
          >
            {{
              submitting
                ? '处理中…'
                : selectedKeys.length > 1
                  ? `批量签发 ${selectedKeys.length} 台`
                  : '签发授权'
            }}
          </button>
          <button type="button" class="btn" :disabled="renewDisabled" @click="submitRenew">
            {{ selectedKeys.length > 1 ? `续期 ${selectedKeys.length} 台` : '续期选中设备' }}
          </button>
        </div>
      </div>
      <p v-if="renewBlockReason.length > 0" class="hint">{{ renewBlockReason }}</p>
      <p v-if="issuanceBlockReason.length > 0" class="hint">{{ issuanceBlockReason }}</p>
      <p v-if="submitError.length > 0" class="form-error">{{ submitError }}</p>

      <p v-if="loading && deviceRows.length === 0" class="hint">正在加载设备与授权…</p>
      <div v-else-if="deviceRows.length === 0" class="empty">
        <strong>还没有登记任何设备</strong>
        <p class="hint">在上方粘贴设备 ID 后登记，登记完成后即可选择设备签发授权。</p>
      </div>
      <table v-else class="table">
        <thead>
          <tr>
            <th class="table__select">
              <input
                type="checkbox"
                :checked="allSelected"
                :aria-label="allSelected ? '取消全选' : '全选设备'"
                @change="onToggleAll"
              />
            </th>
            <th>设备 ID</th>
            <th v-if="showOwnerColumn">归属工程</th>
            <th>授权状态</th>
            <th>授权到期</th>
            <th>剩余天数</th>
            <th class="table__actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in deviceRows" :key="row.key">
            <td class="table__select">
              <input
                type="checkbox"
                :checked="selectedKeys.includes(row.key)"
                :aria-label="`选择设备 ${row.device.deviceId}`"
                @change="toggleDevice(row.key)"
              />
            </td>
            <td class="mono break">
              {{ row.device.deviceId }}
              <StatusBadge v-if="row.device.locked" tone="warn" text="已锁定" />
            </td>
            <td v-if="showOwnerColumn" class="mono break">{{ ownerLabel(row.device.projectId) }}</td>
            <td><StatusBadge :tone="licenseBadge(row).tone" :text="licenseBadge(row).text" /></td>
            <td>{{ row.license === null ? '—' : formatDateTime(row.license.expiresAt) }}</td>
            <td>{{ daysText(row) }}</td>
            <td class="table__actions">
              <button type="button" class="btn btn--ghost" @click="openStatus(row.device)">授权记录</button>
              <button
                type="button"
                class="btn btn--ghost"
                :disabled="locking === row.key"
                @click="toggleLock(row)"
              >
                {{ row.device.locked ? '解锁' : '锁定' }}
              </button>
              <button type="button" class="btn btn--danger" @click="startUnbind(row.device)">解绑</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="deviceRows.length > 0" class="hint">
        按到期紧急程度排序：已过期与 30 天内到期排在前面；「未签发」表示该设备当前没有有效授权记录。
      </p>
    </div>

    <div class="card">
      <div class="card__title">
        <h3>本地网络下发</h3>
        <div class="actions-row">
          <StatusBadge :tone="hubStateBadge.tone" :text="hubStateBadge.text" />
          <button type="button" class="btn btn--ghost" :disabled="hubBusy" @click="refreshHub">刷新</button>
          <button type="button" class="btn btn--primary" :disabled="hubBusy" @click="toggleHub">
            {{ hubBusy ? '处理中…' : hubStatus?.state === 'running' ? '停止服务' : '启动服务' }}
          </button>
        </div>
      </div>
      <dl class="detail-list detail-list--grid">
        <dt>监听地址</dt>
        <dd class="mono">{{ hubStatus?.listenAddress ?? '—' }}</dd>
        <dt>UDP / TCP 端口</dt>
        <dd class="mono">{{ hubStatus?.udpPort ?? '—' }} / {{ hubStatus?.tcpPort ?? '—' }}</dd>
        <dt>发现应答地址</dt>
        <dd class="mono">{{ hubStatus?.advertiseAddress ?? '未启动' }}</dd>
        <dt>请求计数 / 连接</dt>
        <dd>{{ hubStatus?.totalRequests ?? 0 }} / {{ hubStatus?.activeConnections ?? 0 }}</dd>
      </dl>
      <p v-if="hubStatus !== null && !hubStatus.clientSchemaSupported" class="form-error">
        协议不兼容：{{ hubStatus.clientSchemaReason }}。服务可以启动并接收请求，但不会下发授权，
        以免把"未下发"显示成"已发送"；需按协议提案升级 Godot 插件后再联调。
      </p>
      <p v-if="hubStatus?.error" class="form-error">服务错误：{{ hubStatus.error }}</p>
      <p v-if="hubError.length > 0" class="form-error">{{ hubError }}</p>
      <p class="hint">
        监听 0.0.0.0 表示对所有网卡开放（UDP 47820 发现 / TCP 47821 拉取）；请确认只在受控局域网内运行。
        启动与停止需要管理员解锁。
      </p>

      <table v-if="hubRequests.length > 0" class="table table--compact">
        <thead>
          <tr>
            <th>时间</th>
            <th>设备</th>
            <th>来源 IP</th>
            <th>结果</th>
            <th>原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in hubRequests" :key="item.id">
            <td>{{ formatDateTime(item.at) }}</td>
            <td class="mono break">{{ item.deviceId }}</td>
            <td class="mono">{{ item.ip ?? '—' }}</td>
            <td>
              <StatusBadge
                :tone="item.result === 'issued' ? 'ok' : item.result === 'unchanged' ? 'muted' : 'danger'"
                :text="item.result"
              />
            </td>
            <td class="hint break">{{ item.reason ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">还没有收到任何拉取请求。</p>
    </div>

    <div v-if="issued.length > 0 || issueErrors.length > 0" class="card">
      <div class="card__title">
        <h3>本次操作结果</h3>
        <span class="hint">成功 {{ issued.length }} 台 · 失败归属 {{ issueErrors.length }} 个</span>
      </div>

      <ul v-if="issueErrors.length > 0" class="init-state__list">
        <li v-for="item in issueErrors" :key="item.projectId">
          <StatusBadge tone="danger" text="失败" />
          <span class="mono">{{ ownerLabel(item.projectId) }}（{{ item.projectId }}）</span>
          <span class="hint">— {{ item.message }}</span>
        </li>
      </ul>

      <table v-if="issued.length > 0" class="table table--compact">
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

      <div v-if="issued.length > 0" class="delivery">
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
        <p class="hint">同一张中控证书可在有效期内继续签发，受工程范围、有效期与最大设备数约束。</p>
      </div>
    </div>

    <ModalDialog :open="showAddProject" title="添加设备归属工程" width="560px" @close="showAddProject = false">
      <div class="form-grid form-grid--single">
        <p class="hint">
          工程 ID 必须与 Godot 插件 Dock 显示的值一致；名称只用于显示，不参与授权校验。
        </p>
        <label class="field">
          <span>工程 ID</span>
          <input v-model="addProjectForm.projectId" placeholder="从 Godot 插件 Dock 复制，例如 3f9a1c7d20" />
        </label>
        <label class="field">
          <span>显示名称</span>
          <input v-model="addProjectForm.name" placeholder="例如 展厅主控程序" />
        </label>
        <p v-if="certificate !== null && scopeIsWildcard" class="hint">
          当前证书范围为全部工程（*），添加后即可登记设备。
        </p>
        <p v-else-if="certificate !== null" class="hint">
          当前证书范围：{{ scopeLabel }}。不在范围内的工程可以建立关联，但登记与签发会被拒绝。
        </p>
        <p v-if="addProjectError.length > 0" class="form-error">{{ addProjectError }}</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="showAddProject = false">取消</button>
        <button type="button" class="btn btn--primary" :disabled="addingProject" @click="submitAddProject">
          {{ addingProject ? '添加中…' : '添加' }}
        </button>
      </template>
    </ModalDialog>

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

    <ModalDialog :open="statusTarget !== null" title="设备授权记录" width="720px" @close="statusTarget = null">
      <div v-if="statusTarget !== null">
        <dl class="detail-list">
          <dt>设备 ID</dt>
          <dd class="mono break">{{ statusTarget.deviceId }}</dd>
          <dt>登记 / 锁定 / 解绑</dt>
          <dd>
            {{ formatDateTime(statusTarget.registeredAt) }} /
            {{ formatDateTime(statusTarget.lockedAt) }} /
            {{ formatDateTime(statusTarget.unbindAt) }}
          </dd>
        </dl>

        <p v-if="statusLoading" class="hint">正在校验授权文件…</p>
        <p v-else-if="statusError.length > 0" class="form-error">{{ statusError }}</p>
        <template v-else>
          <h4 class="section-title">当前授权</h4>
          <template v-if="statusDetail !== null && statusDetail.license !== null">
            <dl class="detail-list">
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
              <dd class="mono break">{{ licenseFilePath(statusDetail.license) }}</dd>
              <dt>文件校验</dt>
              <dd>
                <StatusBadge
                  :tone="fileCheckOk(statusDetail.file.code) ? 'ok' : 'danger'"
                  :text="fileCheckLabel(statusDetail.file.code)"
                />
              </dd>
            </dl>
          </template>
          <p v-else class="hint">该设备当前没有有效授权记录。</p>

          <h4 class="section-title">历史授权记录（{{ statusHistory.length }}）</h4>
          <p v-if="statusHistory.length === 0" class="hint">还没有签发过授权。</p>
          <table v-else class="table table--compact">
            <thead>
              <tr>
                <th>授权 ID</th>
                <th>签发</th>
                <th>到期</th>
                <th>状态</th>
                <th>文件</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="license in statusHistory" :key="license.licenseId">
                <td class="mono">{{ license.licenseId }}</td>
                <td>{{ formatDateTime(license.issuedAt) }}</td>
                <td>{{ formatDateTime(license.expiresAt) }}</td>
                <td>
                  <StatusBadge :tone="historyStateLabel(license).tone" :text="historyStateLabel(license).text" />
                </td>
                <td class="mono break">{{ license.fileName }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="statusTarget = null">关闭</button>
      </template>
    </ModalDialog>
  </section>
</template>
