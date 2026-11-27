<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CannedResponse } from '@/api/client'
import { send } from '@/background/messages'
import { ApiError } from '@/api/errors'
import { en } from '@/i18n/en'
import CannedPicker from './CannedPicker.vue'

const props = defineProps<{ reference: string; canned: CannedResponse[] | null }>()
const emit = defineEmits<{ sent: [] }>()

const DRAFT_DELAY_MS = 500

const body = ref('')
const internal = ref(false)
const sending = ref(false)
const error = ref('')
const area = ref<HTMLTextAreaElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let loaded = false

const draftKey = () => `draft:${props.reference}`

async function loadDraft(): Promise<void> {
  loaded = false
  const key = draftKey()
  try {
    const stored = (await chrome.storage.session.get(key))[key]
    // Do not clobber what the agent typed while the read was pending.
    if (typeof stored === 'string' && body.value === '') body.value = stored
  } catch {
    // Drafts are a convenience.
  }
  loaded = true
}

async function saveDraft(text: string): Promise<void> {
  try {
    if (text === '') await chrome.storage.session.remove(draftKey())
    else await chrome.storage.session.set({ [draftKey()]: text })
  } catch {
    // Drafts are a convenience.
  }
}

watch(body, (text) => {
  if (!loaded) return
  clearTimeout(timer)
  timer = setTimeout(() => void saveDraft(text), DRAFT_DELAY_MS)
})

onMounted(loadDraft)
onBeforeUnmount(() => {
  // Flush so leaving the ticket inside the debounce window does not lose the text.
  if (timer !== undefined) {
    clearTimeout(timer)
    void saveDraft(body.value)
  }
})

async function submit(): Promise<void> {
  const text = body.value.trim()
  if (sending.value || text === '') return
  sending.value = true
  error.value = ''
  try {
    await send('reply', props.reference, text, internal.value)
  } catch (e) {
    error.value = e instanceof ApiError && e.message ? e.message : en.reply.sendFailed
    sending.value = false
    return
  }
  clearTimeout(timer)
  timer = undefined
  body.value = ''
  await saveDraft('')
  sending.value = false
  emit('sent')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    void submit()
  }
}

function insertCanned(text: string): void {
  const el = area.value
  const at = el?.selectionStart ?? body.value.length
  const to = el?.selectionEnd ?? at
  body.value = body.value.slice(0, at) + text + body.value.slice(to)
  const caret = at + text.length
  queueMicrotask(() => {
    el?.focus()
    el?.setSelectionRange(caret, caret)
  })
}
</script>

<template>
  <form class="reply" @submit.prevent="submit">
    <div class="bar">
      <div class="modes" role="group" :aria-label="en.reply.modeLabel">
        <button
          type="button"
          class="mode"
          :aria-pressed="!internal"
          :disabled="sending"
          @click="internal = false"
        >
          {{ en.reply.reply }}
        </button>
        <button
          type="button"
          class="mode"
          :aria-pressed="internal"
          :disabled="sending"
          @click="internal = true"
        >
          {{ en.reply.note }}
        </button>
      </div>
      <CannedPicker
        v-if="canned && canned.length > 0"
        :items="canned"
        :disabled="sending"
        @pick="insertCanned"
      />
    </div>
    <textarea
      ref="area"
      v-model="body"
      rows="4"
      :class="{ note: internal }"
      :disabled="sending"
      :aria-label="internal ? en.reply.placeholderNote : en.reply.placeholderReply"
      :placeholder="internal ? en.reply.placeholderNote : en.reply.placeholderReply"
      @keydown="onKeydown"
    ></textarea>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="foot">
      <span class="hint">{{ en.reply.hint }}</span>
      <button type="submit" class="send" :disabled="sending || body.trim() === ''">
        {{ sending ? en.reply.sending : internal ? en.reply.sendNote : en.reply.send }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.reply {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px 12px;
  background: var(--esc-panel-sidebar-bg);
  border-top: 1px solid var(--esc-panel-border);
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.modes {
  display: flex;
}
.mode {
  font: inherit;
  font-size: 12px;
  padding: 3px 9px;
  color: var(--esc-panel-text-secondary);
  background: var(--esc-panel-surface);
  border: 1px solid var(--esc-panel-border-input);
  cursor: pointer;
}
.mode:first-child {
  border-radius: 6px 0 0 6px;
}
.mode:last-child {
  border-radius: 0 6px 6px 0;
  border-left: 0;
}
.mode[aria-pressed='true'] {
  color: var(--esc-panel-primary-text);
  background: var(--esc-panel-primary-bg);
  border-color: var(--esc-panel-primary-bg);
}
textarea {
  font: inherit;
  font-size: 13px;
  color: var(--esc-panel-text);
  background: var(--esc-panel-surface);
  border: 1px solid var(--esc-panel-border-input);
  border-radius: 6px;
}
textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  resize: vertical;
}
textarea.note {
  background: var(--esc-panel-note-bg);
  border-color: var(--esc-panel-note-border);
}
.mode:focus-visible,
textarea:focus-visible,
.send:focus-visible {
  outline: 2px solid var(--esc-panel-accent);
  outline-offset: 1px;
}
.error {
  margin: 0;
  font-size: 12px;
  color: var(--esc-sla-breach);
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.hint {
  font-size: 11px;
  color: var(--esc-panel-text-tertiary);
}
.send {
  font: inherit;
  padding: 4px 12px;
  color: var(--esc-panel-primary-text);
  background: var(--esc-panel-primary-bg);
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
button:disabled,
textarea:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
