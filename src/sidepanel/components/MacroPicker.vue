<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Macro } from '@/api/client'
import { send } from '@/background/messages'
import { ApiError } from '@/api/errors'
import { en } from '@/i18n/en'

const props = defineProps<{ reference: string; macros: Macro[] }>()
const emit = defineEmits<{ applied: [] }>()

const picked = ref('')
const pendingId = ref<number | null>(null)
const busy = ref(false)
const error = ref('')

const pending = computed(() => props.macros.find((m) => m.id === pendingId.value))

function choose(): void {
  const id = Number(picked.value)
  picked.value = ''
  error.value = ''
  pendingId.value = props.macros.some((m) => m.id === id) ? id : null
}

async function apply(): Promise<void> {
  const macro = pending.value
  if (!macro || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await send('applyMacro', props.reference, macro.id)
    pendingId.value = null
    emit('applied')
  } catch (e) {
    error.value = e instanceof ApiError && e.message ? e.message : en.macro.failed
    pendingId.value = null
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="macro-wrap">
    <div v-if="pending" class="macro-confirm" role="group" :aria-label="en.macro.label">
      <span>{{ en.macro.confirm.split('{name}').join(pending.name) }}</span>
      <button type="button" class="macro-yes" :disabled="busy" @click="apply">
        {{ busy ? en.macro.applying : en.macro.yes }}
      </button>
      <button type="button" class="macro-no" :disabled="busy" @click="pendingId = null">
        {{ en.macro.no }}
      </button>
    </div>
    <template v-else>
      <label class="sr" for="macro-picker">{{ en.macro.label }}</label>
      <select id="macro-picker" v-model="picked" class="macro" @change="choose">
        <option value="" disabled>{{ en.macro.placeholder }}</option>
        <option v-for="m in macros" :key="m.id" :value="String(m.id)">{{ m.name }}</option>
      </select>
    </template>
    <p v-if="error" class="macro-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.macro-confirm {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
}
select,
button {
  font: inherit;
  font-size: 12px;
  color: var(--esc-panel-text-secondary);
  background: var(--esc-panel-surface);
  border: 1px solid var(--esc-panel-border-input);
  border-radius: 6px;
  padding: 3px 6px;
}
button {
  cursor: pointer;
}
.macro-yes {
  color: var(--esc-panel-primary-text);
  background: var(--esc-panel-primary-bg);
  border-color: var(--esc-panel-primary-bg);
}
select:focus-visible,
button:focus-visible {
  outline: 2px solid var(--esc-panel-accent);
  outline-offset: 1px;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
.macro-error {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--esc-sla-breach);
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
