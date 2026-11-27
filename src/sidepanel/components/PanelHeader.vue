<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Session } from '@/api/client'
import { disconnect } from '@/auth/connect'
import { en } from '@/i18n/en'

const props = defineProps<{ session: Session }>()
const emit = defineEmits<{ disconnected: [] }>()

const confirming = ref(false)
const busy = ref(false)

const host = computed(() => new URL(props.session.origin).host)
const insecure = computed(() => props.session.origin.startsWith('http:'))

async function confirm(): Promise<void> {
  busy.value = true
  try {
    await disconnect()
  } finally {
    busy.value = false
    confirming.value = false
    emit('disconnected')
  }
}
</script>

<template>
  <header class="head">
    <div class="who">
      <span class="host">{{ host }}</span>
      <span class="name">{{ session.user.name }}</span>
      <span v-if="insecure" class="warn">{{ en.header.notEncrypted }}</span>
    </div>
    <div v-if="confirming" class="confirm" role="group" :aria-label="en.header.confirm">
      <span>{{ en.header.confirm }}</span>
      <button type="button" class="danger" :disabled="busy" @click="confirm">
        {{ en.header.confirmYes }}
      </button>
      <button type="button" :disabled="busy" @click="confirming = false">
        {{ en.header.confirmNo }}
      </button>
    </div>
    <button v-else type="button" class="quiet" @click="confirming = true">
      {{ en.header.disconnect }}
    </button>
  </header>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
  background: var(--esc-panel-topbar-bg);
  border-bottom: 1px solid var(--esc-panel-border);
}
.who {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.host {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name {
  color: var(--esc-panel-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.warn {
  color: var(--esc-sla-warn);
}
.confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
button {
  font: inherit;
  padding: 3px 8px;
  color: var(--esc-panel-text-secondary);
  background: var(--esc-panel-surface);
  border: 1px solid var(--esc-panel-border-input);
  border-radius: 6px;
  cursor: pointer;
}
button.quiet {
  background: transparent;
}
button.danger {
  color: var(--esc-panel-primary-text);
  background: var(--esc-sla-breach);
  border-color: var(--esc-sla-breach);
}
button:focus-visible {
  outline: 2px solid var(--esc-panel-accent);
  outline-offset: 1px;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
