<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ADMIN_PASSWORD_MIN_LENGTH, type AdminStatusDto } from '@shared/license/admin-contract'
import ModalDialog from '@renderer/components/ModalDialog.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import { adminApi, errorMessage, unwrap } from '@renderer/lib/api'
import { formatDateTime } from '@renderer/lib/format'

/**
 * 管理员会话入口（顶栏）。
 * 这里只负责展示与提交口令；真正的校验与会话状态全部在主进程，
 * 界面隐藏按钮不构成安全边界，未解锁时敏感 IPC 会被主进程拒绝。
 */
const status = ref<AdminStatusDto | null>(null)
const loadError = ref('')
const busy = ref(false)
const formError = ref('')
const mode = ref<'closed' | 'setup' | 'unlock'>('closed')
const password = ref('')
const confirmPassword = ref('')

const idleMinutes = computed(() => {
  const remaining = status.value?.idleRemainingMs ?? 0
  return Math.max(0, Math.ceil(remaining / 60_000))
})

const lockedOut = computed(() => {
  const until = status.value?.lockedOutUntil ?? null
  return until === null ? '' : formatDateTime(until)
})

async function refresh(): Promise<void> {
  try {
    status.value = unwrap(await adminApi().status())
    loadError.value = ''
  } catch (error) {
    loadError.value = errorMessage(error)
  }
}

function openSetup(): void {
  mode.value = 'setup'
  password.value = ''
  confirmPassword.value = ''
  formError.value = ''
}

function openUnlock(): void {
  mode.value = 'unlock'
  password.value = ''
  confirmPassword.value = ''
  formError.value = ''
}

function closeDialog(): void {
  if (busy.value) {
    return
  }
  mode.value = 'closed'
  password.value = ''
  confirmPassword.value = ''
  formError.value = ''
}

async function submit(): Promise<void> {
  formError.value = ''
  if (mode.value === 'setup') {
    if (password.value.length < ADMIN_PASSWORD_MIN_LENGTH) {
      formError.value = `管理员口令至少 ${ADMIN_PASSWORD_MIN_LENGTH} 个字符`
      return
    }
    if (password.value !== confirmPassword.value) {
      formError.value = '两次输入的口令不一致'
      return
    }
  } else if (password.value.length === 0) {
    formError.value = '请输入管理员口令'
    return
  }

  busy.value = true
  try {
    const api = adminApi()
    status.value =
      mode.value === 'setup'
        ? unwrap(await api.setup({ password: password.value }))
        : unwrap(await api.unlock({ password: password.value }))
    mode.value = 'closed'
    password.value = ''
    confirmPassword.value = ''
  } catch (error) {
    formError.value = errorMessage(error)
    await refresh()
  } finally {
    busy.value = false
  }
}

async function lock(): Promise<void> {
  busy.value = true
  try {
    status.value = unwrap(await adminApi().lock())
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await refresh()
  // 会话空闲超时由主进程判定，这里只定期同步剩余时间并让界面及时回到只读态
  timer = setInterval(() => {
    void refresh()
  }, 30_000)
})

onUnmounted(() => {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
})
</script>

<template>
  <div class="admin-gate">
    <span v-if="loadError.length > 0" class="hint">{{ loadError }}</span>
    <template v-else-if="status !== null">
      <StatusBadge v-if="!status.credentialConfigured" tone="warn" text="未设置管理员口令" />
      <template v-else-if="status.unlocked">
        <StatusBadge tone="ok" :text="`已解锁 · 剩 ${idleMinutes} 分钟`" />
        <button type="button" class="btn btn--ghost" :disabled="busy" @click="lock">锁定</button>
      </template>
      <template v-else>
        <StatusBadge tone="muted" :text="lockedOut.length > 0 ? `登录已锁定至 ${lockedOut}` : '只读模式'" />
        <button type="button" class="btn" :disabled="busy" @click="openUnlock">解锁</button>
      </template>
      <button
        v-if="!status.credentialConfigured"
        type="button"
        class="btn btn--primary"
        :disabled="busy"
        @click="openSetup"
      >
        设置管理员口令
      </button>
    </template>
    <span v-else class="hint">正在确认管理员状态…</span>
  </div>

  <ModalDialog
    :open="mode !== 'closed'"
    :title="mode === 'setup' ? '设置管理员口令' : '解锁管理员'"
    width="460px"
    @close="closeDialog"
  >
    <div class="form-grid form-grid--single">
      <p v-if="mode === 'setup'" class="hint">
        口令只在本机主进程用 scrypt 加盐保存，不写入日志、不传回界面。
        本机口令用于防止现场误操作，不能防御已能以本机账户运行程序的攻击者。
      </p>
      <p v-else-if="status !== null && status.remainingAttempts < 5" class="hint">
        还可尝试 {{ status.remainingAttempts }} 次，超过后会被临时锁定。
      </p>
      <label class="field">
        <span>{{ mode === 'setup' ? `管理员口令（至少 ${ADMIN_PASSWORD_MIN_LENGTH} 个字符）` : '管理员口令' }}</span>
        <input v-model="password" type="password" autocomplete="new-password" @keyup.enter="submit" />
      </label>
      <label v-if="mode === 'setup'" class="field">
        <span>再次输入口令</span>
        <input v-model="confirmPassword" type="password" autocomplete="new-password" @keyup.enter="submit" />
      </label>
      <p v-if="formError.length > 0" class="form-error">{{ formError }}</p>
    </div>
    <template #footer>
      <button type="button" class="btn" :disabled="busy" @click="closeDialog">取消</button>
      <button type="button" class="btn btn--primary" :disabled="busy" @click="submit">
        {{ busy ? '处理中…' : mode === 'setup' ? '保存口令' : '解锁' }}
      </button>
    </template>
  </ModalDialog>
</template>
