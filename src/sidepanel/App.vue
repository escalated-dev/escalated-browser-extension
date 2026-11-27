<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Session } from '@/api/client'
import { PENDING_OPEN_KEY } from '@/background/notify'
import { PENDING_CREATE_KEY } from '@/background/contextMenu'
import type { OpenTicketMessage } from '@/background/messages'
import { getSession } from '@/state/storage'
import PanelHeader from './components/PanelHeader.vue'
import ConnectView from './views/ConnectView.vue'
import QueueView from './views/QueueView.vue'
import CreateView from './views/CreateView.vue'
import TicketView from './views/TicketView.vue'
import { openTicket, router, showCreate, showQueue } from './router'

const PENDING_MAX_AGE_MS = 2 * 60 * 1000
const LAST_ADDRESS_KEY = 'lastAddress'

const loaded = ref(false)
const session = ref<Session | null>(null)
const needsReconnect = ref(false)
const lastAddress = ref('')

// The worker clears storage on a 401, so the last address is kept here in the panel.
function readLastAddress(): string {
  try {
    return localStorage.getItem(LAST_ADDRESS_KEY) ?? ''
  } catch {
    return ''
  }
}
function rememberAddress(origin: string): void {
  lastAddress.value = origin
  try {
    localStorage.setItem(LAST_ADDRESS_KEY, origin)
  } catch {
    // Optional convenience.
  }
}

async function refresh(): Promise<void> {
  const [s, flag] = await Promise.all([getSession(), chrome.storage.local.get('needsReconnect')])
  session.value = s
  needsReconnect.value = flag['needsReconnect'] === true
  if (s) rememberAddress(s.origin)
  loaded.value = true
}

function onConnected(s: Session): void {
  session.value = s
  needsReconnect.value = false
  rememberAddress(s.origin)
  // A ticket opened from a notification while signed out is kept, not dropped.
  if (router.view !== 'ticket' && router.view !== 'create') showQueue()
}

function onDisconnected(): void {
  session.value = null
  needsReconnect.value = false
  showQueue()
}

type Pending = { reference?: unknown; at?: unknown }

async function consumePending(value?: unknown): Promise<void> {
  const pending = (value ?? (await chrome.storage.session.get(PENDING_OPEN_KEY))[PENDING_OPEN_KEY]) as
    Pending | undefined
  if (!pending) return
  await chrome.storage.session.remove(PENDING_OPEN_KEY)
  if (
    typeof pending.reference === 'string' &&
    typeof pending.at === 'number' &&
    Date.now() - pending.at < PENDING_MAX_AGE_MS
  ) {
    openTicket(pending.reference)
  }
}

type PendingCreate = { selection?: unknown; title?: unknown; url?: unknown; at?: unknown }

async function consumePendingCreate(value?: unknown): Promise<void> {
  const pending = (value ?? (await chrome.storage.session.get(PENDING_CREATE_KEY))[PENDING_CREATE_KEY]) as
    PendingCreate | undefined
  if (!pending) return
  await chrome.storage.session.remove(PENDING_CREATE_KEY)
  if (typeof pending.at !== 'number' || Date.now() - pending.at >= PENDING_MAX_AGE_MS) return
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  showCreate({ selection: text(pending.selection), title: text(pending.title), url: text(pending.url) })
}

function onMessage(
  msg: unknown,
  sender: { id?: string },
  sendResponse: (r?: unknown) => void,
): boolean | undefined {
  if (sender.id !== chrome.runtime.id) return undefined
  const m = msg as Partial<OpenTicketMessage> | null
  if (m?.type !== 'open-ticket' || typeof m.reference !== 'string') return undefined
  openTicket(m.reference)
  sendResponse({ ok: true })
  return undefined
}

type Changes = Record<string, { newValue?: unknown }>
function onStorage(changes: Changes, area: string): void {
  if (area === 'local' && ('session' in changes || 'needsReconnect' in changes)) void refresh()
  if (area === 'session' && changes[PENDING_OPEN_KEY]?.newValue) {
    void consumePending(changes[PENDING_OPEN_KEY].newValue)
  }
  if (area === 'session' && changes[PENDING_CREATE_KEY]?.newValue) {
    void consumePendingCreate(changes[PENDING_CREATE_KEY].newValue)
  }
}

onMounted(() => {
  lastAddress.value = readLastAddress()
  chrome.runtime.onMessage.addListener(onMessage)
  chrome.storage.onChanged.addListener(onStorage)
  void refresh().then(async () => {
    await consumePending()
    await consumePendingCreate()
  })
})
onBeforeUnmount(() => {
  chrome.runtime.onMessage.removeListener(onMessage)
  chrome.storage.onChanged.removeListener(onStorage)
})
</script>

<template>
  <main class="panel">
    <template v-if="loaded">
      <ConnectView
        v-if="!session"
        :reconnect="needsReconnect"
        :initial-address="lastAddress"
        @connected="onConnected"
      />
      <template v-else>
        <PanelHeader :session="session" @disconnected="onDisconnected" />
        <KeepAlive>
          <QueueView v-if="router.view === 'queue'" :session="session" @open="openTicket" />
        </KeepAlive>
        <CreateView
          v-if="router.view === 'create'"
          :key="JSON.stringify(router.createPrefill ?? null)"
          :session="session"
          :prefill="router.createPrefill"
        />
        <TicketView
          v-if="router.view === 'ticket' && router.currentReference"
          :key="router.currentReference"
          :session="session"
          :reference="router.currentReference"
          @back="showQueue"
        />
      </template>
    </template>
  </main>
</template>

<style scoped>
.panel {
  min-height: 100vh;
  color: var(--esc-panel-text);
  background: var(--esc-panel-bg);
  font-size: 13px;
}
</style>
