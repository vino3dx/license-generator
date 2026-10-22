<script setup lang="ts">
defineProps<{
  message: string
  tone?: 'danger' | 'success' | 'info'
}>()

const emit = defineEmits<{ dismiss: [] }>()
</script>

<template>
  <div class="banner" :class="`banner--${tone ?? 'danger'}`" role="status">
    <span>{{ message }}</span>
    <button type="button" class="banner__close" aria-label="关闭提示" @click="emit('dismiss')">×</button>
  </div>
</template>
