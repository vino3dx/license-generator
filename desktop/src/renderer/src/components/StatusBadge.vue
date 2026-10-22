<script setup lang="ts">
defineProps<{
  tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info'
  text: string
}>()
</script>

<template>
  <span class="badge" :class="`badge--${tone}`">{{ text }}</span>
</template>
