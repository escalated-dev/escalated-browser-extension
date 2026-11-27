<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Agent, CannedResponse, Macro, Session, Ticket } from '@/api/client'
import { ApiError } from '@/api/errors'
import { send } from '@/background/messages'
import { en } from '@/i18n/en'
import MacroPicker from '../components/MacroPicker.vue'
import ReplyBox from '../components/ReplyBox.vue'
import Thread from '../components/Thread.vue'
import TriageBar from '../components/TriageBar.vue'
import { relativeTime } from '../time'

const props = defineProps<{ session: Session; reference: string }>()
const emit = defineEmits<{ back: [] }>()

const ticket = ref<Ticket | null>(null)
const agents = ref<Agent[]>([])
const canned = ref<CannedResponse[] | null>(null)
const macros = ref<Macro[] | null>(null)
const loading = ref(true)
const error = ref('')
let seq = 0

const features = computed(() => props.session.meta.features)
const wantsCanned = computed(() => features.value.includes('canned_responses'))
const wantsMacros = computed(
  () => features.value.includes('macros') && features.value.includes('tickets.macro'),
)

// A late answer must never overwrite a newer one.
async function load(): Promise<void> {
  const mine = ++seq
  error.value = ''
  try {
    const res = await send('getTicket', props.reference)
    if (mine !== seq) return
    if (!res?.data || typeof res.data.reference !== 'string') throw new ApiError(en.ticket.loadError, 0)
    ticket.value = res.data
  } catch (e) {
    if (mine !== seq) return
    error.value = e instanceof ApiError && e.message ? e.message : en.ticket.loadError
  } finally {
    if (mine === seq) loading.value = false
  }
}

async function loadLists(): Promise<void> {
  const [a, c, m] = await Promise.allSettled([
    send('agents'),
    wantsCanned.value ? send('cannedResponses') : Promise.resolve(null),
    wantsMacros.value ? send('macros') : Promise.resolve(null),
  ])
  if (a.status === 'fulfilled') agents.value = a.value.data
  if (c.status === 'fulfilled' && c.value) canned.value = c.value.data
  if (m.status === 'fulfilled' && m.value) macros.value = m.value.data
}

onMounted(() => {
  void load()
  void loadLists()
})

const helpdeskUrl = computed(() => {
  const template = props.session.meta.web_url_template
  return template ? template.split('{reference}').join(encodeURIComponent(props.reference)) : null
})

const requesterName = computed(
  () => ticket.value?.requester.name || ticket.value?.requester.email || en.ticket.noRequester,
)

function due(label: string, iso: string | null, breached: boolean) {
  if (!iso) return null
  return { text: `${label} ${relativeTime(iso)}`, breached }
}

const slaLines = computed(() => {
  const sla = ticket.value?.sla
  if (!sla) return []
  return [
    due(en.ticket.firstResponseDue, sla.first_response_due_at, sla.first_response_breached),
    due(en.ticket.resolutionDue, sla.resolution_due_at, sla.resolution_breached),
  ].filter((l): l is { text: string; breached: boolean } => l !== null)
})
</script>

<template>
  <div class="ticket">
    <div class="top">
      <button type="button" class="back" @click="emit('back')">{{ en.ticket.back }}</button>
      <a v-if="helpdeskUrl" class="helpdesk" :href="helpdeskUrl" target="_blank" rel="noopener">{{
        en.ticket.openInHelpdesk
      }}</a>
    </div>

    <p v-if="loading" class="state" role="status">{{ en.ticket.loading }}</p>
    <p v-else-if="error && !ticket" class="state error" role="alert">
      {{ error }}
      <button type="button" class="retry" @click="load">{{ en.ticket.retry }}</button>
    </p>

    <template v-if="ticket">
      <p v-if="error" class="refresh-error" role="alert">
        {{ en.ticket.refreshError }}
        <button type="button" class="refresh-retry" @click="load">{{ en.ticket.refreshRetry }}</button>
      </p>
      <section class="head">
        <h1 class="title">
          <span class="ref">#{{ ticket.reference }}</span> {{ ticket.subject }}
        </h1>
        <p class="requester">
          {{ requesterName }}
          <span v-if="ticket.requester.email && ticket.requester.email !== requesterName" class="email">
            {{ ticket.requester.email }}
          </span>
        </p>
        <p class="facts">
          <span class="fact">{{ ticket.status_label }}</span>
          <span class="fact priority-fact" :data-priority="ticket.priority">{{ ticket.priority_label }}</span>
          <span v-if="ticket.assignee" class="fact">{{ ticket.assignee.name }}</span>
          <span v-if="ticket.department" class="fact">{{ ticket.department.name }}</span>
        </p>
        <p v-for="l in slaLines" :key="l.text" class="sla" :class="{ 'sla-breach': l.breached }">
          {{ l.text }}
        </p>
        <TriageBar :ticket="ticket" :agents="agents" :me-id="session.user.id" @changed="load" />
        <MacroPicker
          v-if="macros && macros.length > 0"
          :reference="reference"
          :macros="macros"
          @applied="load"
        />
      </section>
      <Thread :replies="ticket.replies ?? []" :requester-name="requesterName" />
      <ReplyBox :reference="reference" :canned="canned" @sent="load" />
    </template>
  </div>
</template>

<style scoped>
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 12px;
  border-bottom: 1px solid var(--esc-panel-border);
}
.back {
  font: inherit;
  color: var(--esc-panel-accent);
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}
.helpdesk {
  color: var(--esc-panel-accent);
}
.back:focus-visible,
.helpdesk:focus-visible,
.retry:focus-visible,
.refresh-retry:focus-visible {
  outline: 2px solid var(--esc-panel-accent);
  outline-offset: 2px;
}
.state {
  margin: 0;
  padding: 16px 12px;
  font-size: 12px;
  text-align: center;
  color: var(--esc-panel-text-tertiary);
}
.state.error {
  color: var(--esc-sla-breach);
}
.refresh-error {
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--esc-sla-breach);
  border-bottom: 1px solid var(--esc-panel-border);
}
.refresh-retry,
.retry {
  font: inherit;
  color: var(--esc-panel-accent);
  background: none;
  border: 0;
  text-decoration: underline;
  cursor: pointer;
}
.head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--esc-panel-border);
}
.title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.ref {
  color: var(--esc-panel-text-secondary);
}
.requester,
.facts,
.sla {
  margin: 0;
  font-size: 12px;
  color: var(--esc-panel-text-tertiary);
}
.email {
  margin-left: 4px;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.priority-fact {
  font-weight: 600;
}
.priority-fact[data-priority='low'] {
  color: var(--esc-priority-low);
}
.priority-fact[data-priority='medium'] {
  color: var(--esc-priority-medium);
}
.priority-fact[data-priority='high'] {
  color: var(--esc-priority-high);
}
.priority-fact[data-priority='urgent'],
.priority-fact[data-priority='critical'] {
  color: var(--esc-priority-urgent);
}
.sla-breach {
  color: var(--esc-sla-breach);
  font-weight: 600;
}
</style>
