<script setup lang="ts">
defineProps<{
  open: boolean
  title: string
  width?: string
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal" role="dialog" aria-modal="true" @click.self="emit('close')">
      <div class="modal__panel" :style="width === undefined ? undefined : { width }">
        <header class="modal__header">
          <h3>{{ title }}</h3>
          <button type="button" class="modal__close" aria-label="关闭" @click="emit('close')">×</button>
        </header>
        <div class="modal__body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="modal__footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
