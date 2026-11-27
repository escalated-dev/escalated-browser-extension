<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, ref, watch } from 'vue'
import type { Session, TicketListItem, TicketQuery, TicketStatus } from '@/api/client'
import { send } from '@/background/messages'
import { en } from '@/i18n/en'
import TicketRow from '../components/TicketRow.vue'

const props = defineProps<{ session: Session }>()
const emit = defineEmits<{ open: [reference: string] }>()

type Tab = 'mine' | 'unassigned' | 'open'
const tabs: { id: Tab; label: string }[] = [
  { id: 'mine', label: en.queue.mine },
  { id: 'unassigned', label: en.queue.unassigned },
  { id: 'open', label: en.queue.open },
]

// The contract's statuses, in its order. "default" means open tickets where the helpdesk can
// filter by the open family (tickets.open_filter), and no status filter otherwise.
const STATUSES: TicketStatus[] = [
  'open',
  'in_progress',
  'waiting_on_customer',
  'waiting_on_agent',
  'escalated',
  'resolved',
  'closed',
  'reopened',
  'live',
]
type StatusFilter = 'default' | TicketStatus
const openFilter = computed(() => props.session.meta.features.includes('tickets.open_filter'))
const statusOptions = computed(() => [
  { value: 'default' as StatusFilter, label: openFilter.value ? en.queue.anyOpenStatus : en.queue.anyStatus },
  ...STATUSES.map((s) => ({ value: s as StatusFilter, label: en.ticket.statuses[s] })),
])

const tab = ref<Tab>('mine')
const status = ref<StatusFilter>('default')
const search = ref('')
const term = ref('')
const items = ref<TicketListItem[]>([])
const page = ref(0)
const lastPage = ref(0)
const loading = ref(false)
const failed = ref(false)
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined

const query = (): TicketQuery => {
  const q: TicketQuery =
    tab.value === 'mine'
      ? { assigned_to: props.session.user.id as TicketQuery['assigned_to'] }
      : tab.value === 'unassigned'
        ? { unassigned: true }
        : {}
  if (status.value !== 'default') q.status = status.value
  else if (openFilter.value) q.open = true
  else if (tab.value === 'open') q.status = 'open'
  if (term.value) q.search = term.value
  return q
}

async function load(next: number): Promise<void> {
  const mine = ++seq
  loading.value = true
  failed.value = false
  try {
    const res = await send('listTickets', { ...query(), page: next })
    if (mine !== seq) return
    items.value = next === 1 ? res.data : [...items.value, ...res.data]
    page.value = res.meta.current_page
    lastPage.value = res.meta.last_page
  } catch {
    if (mine !== seq) return
    failed.value = true
  } finally {
    if (mine === seq) loading.value = false
  }
}

function reload(): void {
  items.value = []
  page.value = 0
  lastPage.value = 0
  void load(1)
}

watch(tab, reload, { immediate: true })
watch(term, reload)
watch(status, reload)
watch(openFilter, () => {
  if (status.value === 'default') reload()
})
watch(search, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    term.value = v.trim()
  }, 300)
})
onBeforeUnmount(() => clearTimeout(timer))

// Coming back from a ticket keeps the tab and search; refresh the list in place.
let activatedOnce = false
onActivated(() => {
  if (activatedOnce) void load(1)
  activatedOnce = true
})

const hasMore = computed(() => page.value < lastPage.value)
const empty = computed(() => {
  if (term.value) return en.queue.emptySearch
  if (status.value !== 'default') return en.queue.emptyStatus
  return tab.value === 'mine'
    ? en.queue.emptyMine
    : tab.value === 'unassigned'
      ? en.queue.emptyUnassigned
      : en.queue.emptyOpen
})
</script>

<template>
  <div class="queue">
    <div class="tabs" role="group" :aria-label="en.queue.tabsLabel">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        class="tab"
        :aria-current="tab === t.id ? 'true' : undefined"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
    </div>
    <div class="search">
      <label class="sr" for="queue-search">{{ en.queue.searchLabel }}</label>
      <input
        id="queue-search"
        v-model="search"
        type="search"
        autocomplete="off"
        :placeholder="en.queue.searchPlaceholder"
      />
      <label class="sr" for="queue-status">{{ en.queue.statusLabel }}</label>
      <select id="queue-status" v-model="status">
        <option v-for="o in statusOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>

    <p v-if="failed" class="state error" role="alert">
      {{ en.queue.loadError }}
      <button type="button" class="link" @click="load(page + 1)">{{ en.queue.retry }}</button>
    </p>
    <p v-else-if="!loading && items.length === 0" class="state">{{ empty }}</p>

    <TicketRow v-for="t in items" :key="t.id" :ticket="t" @open="emit('open', $event)" />

    <p v-if="loading" class="state" role="status">{{ en.queue.loading }}</p>
    <button v-else-if="hasMore" type="button" class="more" @click="load(page + 1)">
      {{ en.queue.loadMore }}
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  border-bottom: 1px solid var(--esc-panel-border);
}
.tab {
  flex: 1;
  padding: 7px 4px;
  font: inherit;
  font-size: 12px;
  color: var(--esc-panel-text-tertiary);
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.tab[aria-current='true'] {
  color: var(--esc-panel-text);
  font-weight: 600;
  border-bottom-color: var(--esc-panel-selected-border);
}
.tab:focus-visible,
.more:focus-visible,
.link:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--esc-panel-accent);
  outline-offset: -2px;
}
.search {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--esc-panel-border);
}
.search input,
.search select {
  min-width: 0;
  box-sizing: border-box;
  padding: 5px 8px;
  font: inherit;
  font-size: 13px;
  color: var(--esc-panel-text);
  background: var(--esc-panel-surface);
  border: 1px solid var(--esc-panel-border-input);
  border-radius: 6px;
}
.search input {
  flex: 1;
}
.search select {
  flex: 0 1 auto;
  max-width: 45%;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.state {
  margin: 0;
  padding: 16px 12px;
  font-size: 12px;
  color: var(--esc-panel-text-tertiary);
  text-align: center;
}
.state.error {
  color: var(--esc-sla-breach);
}
.link {
  font: inherit;
  color: var(--esc-panel-accent);
  background: none;
  border: 0;
  text-decoration: underline;
  cursor: pointer;
}
.more {
  display: block;
  width: 100%;
  padding: 8px;
  font: inherit;
  font-size: 12px;
  color: var(--esc-panel-accent);
  background: transparent;
  border: 0;
  cursor: pointer;
}
</style>
