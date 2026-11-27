<script setup lang="ts">
import { ref } from 'vue'
import type { CannedResponse } from '@/api/client'
import { en } from '@/i18n/en'

const props = defineProps<{ items: CannedResponse[]; disabled?: boolean }>()
const emit = defineEmits<{ pick: [body: string] }>()

const value = ref('')

function onChange(): void {
  const found = props.items.find((c) => String(c.id) === value.value)
  value.value = ''
  if (found) emit('pick', found.body)
}
</script>

<template>
  <label class="sr" for="reply-canned">{{ en.reply.canned }}</label>
  <select id="reply-canned" v-model="value" class="canned" :disabled="disabled" @change="onChange">
    <option value="" disabled>{{ en.reply.canned }}</option>
    <option v-for="c in items" :key="c.id" :value="String(c.id)">{{ c.title }}</option>
  </select>
</template>

<style scoped>
select {
  max-width: 50%;
  padding: 3px 4px;
  font: inherit;
  font-size: 13px;
  color: var(--esc-panel-text);
  background: var(--esc-panel-surface);
  border: 1px solid var(--esc-panel-border-input);
  border-radius: 6px;
}
select:focus-visible {
  outline: 2px solid var(--esc-panel-accent);
  outline-offset: 1px;
}
select:disabled {
  opacity: 0.6;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
