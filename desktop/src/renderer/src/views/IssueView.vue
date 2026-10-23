<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type {
  ControlCertificateDto,
  DelegatedKeyStatusDto,
  DeviceDto,
  LicenseDto,
  ProjectDto,
  QuotaUsageDto,
  VendorKeyStatusDto
} from '@shared/license/service-contract'
import NoticeBanner from '@renderer/components/NoticeBanner.vue'
import PageHeader from '@renderer/components/PageHeader.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import ModalDialog from '@renderer/components/ModalDialog.vue'
import { appApi, errorMessage, licenseApi, unwrap } from '@renderer/lib/api'
import { daysUntil, formatDateTime, localInputToUtc } from '@renderer/lib/format'

const projects = ref<ProjectDto[]>([])
const devices = ref<DeviceDto[]>([])
const certificate = ref<ControlCertificateDto | null>(null)
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

const certificateText = ref('')
const certificateError = ref('')
const importingCertificate = ref(false)
const showCertificateImport = ref(false)

const privateKeyText = ref('')
const privateKeyError = ref('')
const importingKey = ref(false)
const showKeyImport = ref(false)

const certificateExpired = computed(() => {
  if (certificate.value === null) {
    return false
  }
  const days = daysUntil(certificate.value.expiresAt)
  return days !== null && days <= 0
})

const quotaText = computed(() => {
  if (quota.value === null) {
    return '不可用'
  }
  return `${quota.value.usedDevices} / ${quota.value.maxDevices}`
})

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
  if (certificate.value === null) {
    return '尚未导入中控授权证书'
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

async function refreshAll(): Promise<void> {
  loading.value = true
  try {
    const api = licenseApi()
    const [projectList, controlResult, quotaResult, vendorResult, keyResult] = await Promise.all([
      api.listProjects(),
      api.currentControlCertificate(),
      api.quota(),
      api.vendorKeyStatus(),
      api.delegatedKeyStatus()
    ])
    projects.value = unwrap(projectList)
    certificate.value = unwrap(controlResult)
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
      await licenseApi().listDevices({ projectId: activeProject.value, includeUnbound: false })
    )
  } catch (error) {
    devices.value = []
    notice.value = { message: errorMessage(error), tone: 'danger' }
  }
}

watch(activeProject, loadDevices)

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
    certificateText.value = ''
    showCertificateImport.value = false
    notice.value = { message: `已导入中控证书 ${imported.licenseId}`, tone: 'success' }
    await refreshAll()
  } catch (error) {
    certificateError.value = errorMessage(error)
  } finally {
    importingCertificate.value = false
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
      title="授权签发"
      description="签发能力受厂商中控证书约束；界面禁用只是提示，真正的校验全部在业务层。"
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
        <button v-else type="button" class="btn btn--ghost" @click="showCertificateImport = true">
          导入证书
        </button>
      </div>
      <div class="stat">
        <span class="stat__label">设备额度</span>
        <strong class="stat__value">{{ quotaText }}</strong>
        <span v-if="certificate !== null" class="hint">
          项目范围：{{ certificate.projectIds.includes('*') ? '全部' : certificate.projectIds.join('、') }}
        </span>
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
        <button type="button" class="btn btn--ghost" @click="showKeyImport = true">
          {{ delegatedKey?.configured === true ? '替换私钥' : '导入私钥' }}
        </button>
      </div>
    </div>

    <div v-if="certificate !== null" class="card">
      <div class="card__title">
        <h3>中控证书详情</h3>
        <button type="button" class="btn btn--ghost" @click="showCertificateImport = true">更换证书</button>
      </div>
      <dl class="detail-list detail-list--grid">
        <dt>证书 ID</dt>
        <dd class="mono">{{ certificate.licenseId }}</dd>
        <dt>签发 / 到期</dt>
        <dd>{{ formatDateTime(certificate.issuedAt) }} → {{ formatDateTime(certificate.expiresAt) }}</dd>
        <dt>最大设备数</dt>
        <dd>{{ certificate.maxDevices }}</dd>
        <dt>可用功能</dt>
        <dd>{{ certificate.features.length === 0 ? '（未声明）' : certificate.features.join('、') }}</dd>
        <dt>证书指纹</dt>
        <dd class="mono ellipsis">{{ certificate.kid }}</dd>
        <dt>导入时间</dt>
        <dd>{{ formatDateTime(certificate.importedAt) }}</dd>
      </dl>
    </div>

    <div class="card">
      <div class="card__title">
        <h3>签发子机授权</h3>
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
        <p v-if="activeDevices.length === 0" class="hint">
          该项目还没有已登记且未解绑的设备，请先到「设备管理」登记。
        </p>
        <ul v-else class="device-picker__list">
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
              <th>授权文件（子机 license.dat）</th>
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
        <p class="hint">
          license.dat 已按 v3 协议内嵌中控证书（容器格式），子机只需要这一个文件，无需单独分发 control.cert；
          续期时把新的 license.dat 覆盖到子机同一路径即可。
        </p>
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
  </section>
</template>
