<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue'
import { WORKSPACE_ENTRIES, type AppInfo, type WorkspaceKey } from '@shared/ipc-contract'
import type { ControlCertificateDto } from '@shared/license/service-contract'
import LicenseManageView from '@renderer/views/LicenseManageView.vue'
import RecordsView from '@renderer/views/RecordsView.vue'
import AdminGate from '@renderer/components/AdminGate.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import { appApi, licenseApi } from '@renderer/lib/api'
import { daysUntil } from '@renderer/lib/format'

const views: Record<WorkspaceKey, Component> = {
  license: LicenseManageView,
  records: RecordsView
}

const activeKey = ref<WorkspaceKey>('license')
const activeView = computed<Component>(() => views[activeKey.value])
const appInfo = ref<AppInfo | null>(null)
const certificate = ref<ControlCertificateDto | null>(null)
/** 最近导入的一张证书（含已作废）；只用于状态展示，不等于"当前可用证书" */
const lastCertificate = ref<ControlCertificateDto | null>(null)
const vendorConfigured = ref<boolean | null>(null)
const runtimeError = ref('')

/**
 * 顶栏状态只做"事实汇总"，有效性全部来自业务层查询结果：
 * - certificate 来自 currentControlCertificate()（业务层已验签 + 校验有效期，失败返回 null）
 * - lastCertificate 来自 lastControlCertificate()（最近导入记录，isActive 表示是否被作废/替换）
 */
const controlState = computed<{ tone: 'ok' | 'warn' | 'danger' | 'muted'; text: string }>(() => {
  if (runtimeError.value.length > 0) {
    return { tone: 'danger', text: `状态无法确认：${runtimeError.value}` }
  }
  if (vendorConfigured.value === null) {
    return { tone: 'muted', text: '正在确认中控授权状态…' }
  }
  if (vendorConfigured.value === false) {
    return { tone: 'danger', text: '未配置厂商公钥，不能验证中控证书' }
  }
  if (certificate.value !== null) {
    const days = daysUntil(certificate.value.expiresAt)
    if (days !== null && days <= 0) {
      return { tone: 'danger', text: `中控授权已过期（${certificate.value.licenseId}）` }
    }
    if (days !== null && days <= 30) {
      return { tone: 'warn', text: `中控授权 ${days} 天后到期（${certificate.value.licenseId}）` }
    }
    return { tone: 'ok', text: `中控授权有效（${certificate.value.licenseId}）` }
  }
  // 没有可用证书时，用最近导入记录区分「从未导入」「已作废」「过期或无效」
  if (lastCertificate.value === null) {
    return { tone: 'warn', text: '未导入中控授权证书' }
  }
  if (!lastCertificate.value.isActive) {
    return {
      tone: 'warn',
      text: `中控授权 ${lastCertificate.value.licenseId} 已作废（历史一次性规则），需导入新证书`
    }
  }
  return {
    tone: 'danger',
    text: `中控授权 ${lastCertificate.value.licenseId} 已过期或无效，需导入新证书`
  }
})

onMounted(async () => {
  try {
    appInfo.value = await appApi().getAppInfo()
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : String(error)
  }
  try {
    const api = licenseApi()
    const [controlResult, lastResult, vendorResult] = await Promise.all([
      api.currentControlCertificate(),
      api.lastControlCertificate(),
      api.vendorKeyStatus()
    ])
    if (controlResult.ok) {
      certificate.value = controlResult.value
    } else {
      runtimeError.value = controlResult.error.message
    }
    if (lastResult.ok) {
      lastCertificate.value = lastResult.value
    }
    if (vendorResult.ok) {
      vendorConfigured.value = vendorResult.value.configured
    }
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : String(error)
  }
})
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar__brand">
        <span class="sidebar__mark">A</span>
        <div>
          <h1>Aegis</h1>
          <p>授权管理中控</p>
        </div>
      </div>

      <nav class="sidebar__nav">
        <button
          v-for="entry in WORKSPACE_ENTRIES"
          :key="entry.key"
          type="button"
          class="sidebar__item"
          :class="{ 'sidebar__item--active': entry.key === activeKey }"
          @click="activeKey = entry.key"
        >
          <span class="sidebar__item-title">{{ entry.title }}</span>
          <span class="sidebar__item-summary">{{ entry.summary }}</span>
        </button>
      </nav>

      <footer class="sidebar__footer">
        <span>阶段 5 · 本地授权管理</span>
      </footer>
    </aside>

    <main class="workspace">
      <header class="workspace__topbar">
        <StatusBadge :tone="controlState.tone" :text="controlState.text" />
        <div class="workspace__topbar-right">
          <AdminGate />
          <span class="workspace__meta">
            {{ appInfo === null ? '正在读取运行信息…' : `v${appInfo.appVersion} · Electron ${appInfo.electronVersion} · ${appInfo.platform}` }}
          </span>
        </div>
      </header>

      <div class="workspace__body">
        <component :is="activeView" />
      </div>

      <footer class="workspace__status">
        <span>数据目录：{{ appInfo === null ? '—' : appInfo.userDataPath }}</span>
        <span>{{ appInfo !== null && appInfo.isPackaged ? '生产环境' : '开发环境' }}</span>
      </footer>
    </main>
  </div>
</template>
