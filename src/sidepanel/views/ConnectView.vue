<script setup lang="ts">
import { ref } from 'vue'
import type { Session } from '@/api/client'
import { connect, ConnectError } from '@/auth/connect'
import { connectErrorMessage, en } from '@/i18n/en'

const props = defineProps<{ reconnect?: boolean; initialAddress?: string }>()
const emit = defineEmits<{ connected: [session: Session] }>()

const address = ref(props.initialAddress ?? '')
const apiPath = ref('')
const token = ref('')
const busy = ref(false)
const error = ref('')

// No await before connect(): the permission prompt needs this click's user gesture.
function onSubmit(): void {
  if (busy.value) return
  busy.value = true
  error.value = ''
  const opts: { apiPath?: string; manualToken?: string } = {}
  if (apiPath.value.trim()) opts.apiPath = apiPath.value.trim()
  if (token.value.trim()) opts.manualToken = token.value.trim()
  connect(address.value, opts).then(
    (session) => {
      busy.value = false
      token.value = ''
      emit('connected', session)
    },
    (e: unknown) => {
      busy.value = false
      error.value = connectErrorMessage(e instanceof ConnectError ? e.code : undefined)
    },
  )
}
</script>

<template>
  <form class="connect" novalidate @submit.prevent="onSubmit">
    <h1>{{ en.connect.title }}</h1>
    <p v-if="reconnect" class="notice" role="status">{{ en.connect.reconnectNotice }}</p>

    <label for="address">{{ en.connect.addressLabel }}</label>
    <input
      id="address"
      v-model="address"
      type="text"
      inputmode="url"
      autocomplete="url"
      spellcheck="false"
      :placeholder="en.connect.addressPlaceholder"
      :disabled="busy"
    />

    <details class="advanced">
      <summary>{{ en.connect.advanced }}</summary>
      <label for="api-path">{{ en.connect.apiPathLabel }}</label>
      <input
        id="api-path"
        v-model="apiPath"
        type="text"
        spellcheck="false"
        aria-describedby="api-path-hint"
        :disabled="busy"
      />
      <p id="api-path-hint" class="hint">{{ en.connect.apiPathHint }}</p>
      <label for="token">{{ en.connect.tokenLabel }}</label>
      <input
        id="token"
        v-model="token"
        type="password"
        autocomplete="off"
        spellcheck="false"
        aria-describedby="token-hint"
        :disabled="busy"
      />
      <p id="token-hint" class="hint">{{ en.connect.tokenHint }}</p>
    </details>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <button type="submit" class="primary" :disabled="busy">
      {{ busy ? en.connect.connecting : reconnect ? en.connect.submitReconnect : en.connect.submit }}
    </button>
  </form>
</template>

<style scoped>
.connect {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 12px;
}
h1 {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 4px;
}
label {
  font-size: 12px;
  color: var(--esc-panel-text-secondary);
}
input {
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
  color: var(--esc-panel-text);
  background: var(--esc-panel-surface);
  border: 1px solid var(--esc-panel-border-input);
  border-radius: 6px;
}
input:focus-visible,
summary:focus-visible,
.primary:focus-visible {
  outline: 2px solid var(--esc-panel-accent);
  outline-offset: 1px;
}
.advanced {
  font-size: 12px;
  margin-top: 4px;
}
.advanced summary {
  cursor: pointer;
  color: var(--esc-panel-text-secondary);
}
.advanced input {
  width: 100%;
  box-sizing: border-box;
  margin-top: 4px;
}
.advanced label {
  display: block;
  margin-top: 8px;
}
.hint {
  margin: 2px 0 0;
  color: var(--esc-panel-text-tertiary);
}
.notice {
  margin: 0;
  padding: 6px 8px;
  font-size: 12px;
  background: var(--esc-panel-note-bg);
  border: 1px solid var(--esc-panel-note-border);
  color: var(--esc-panel-note-text);
  border-radius: 6px;
}
.error {
  margin: 0;
  font-size: 12px;
  color: var(--esc-sla-breach);
}
.primary {
  margin-top: 4px;
  padding: 7px 12px;
  font: inherit;
  font-weight: 600;
  font-size: 13px;
  color: var(--esc-panel-primary-text);
  background: var(--esc-panel-primary-bg);
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
