<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Agent, Ticket, TicketPriority, TicketStatus } from '@/api/client'
import { send } from '@/background/messages'
import { ApiError } from '@/api/errors'
import { en } from '@/i18n/en'

const props = defineProps<{ ticket: Ticket; agents: Agent[]; meId: number | string }>()
const emit = defineEmits<{ changed: [] }>()

const STATUSES = Object.keys(en.ticket.statuses) as TicketStatus[]
const PRIORITIES = Object.keys(en.ticket.priorities) as TicketPriority[]

const statusValue = ref<string>(props.ticket.status)
const priorityValue = ref<string>(props.ticket.priority)
const assigneeValue = ref<string>(props.ticket.assignee ? String(props.ticket.assignee.id) : '')
const busy = ref(false)
const statusError = ref('')
const actionError = ref('')

// The server is the source of truth; follow it after each refetch.
watch(
  () => props.ticket,
  (t) => {
    statusValue.value = t.status
    priorityValue.value = t.priority
    assigneeValue.value = t.assignee ? String(t.assignee.id) : ''
  },
)

const assignedToMe = computed(
  () => props.ticket.assignee !== null && String(props.ticket.assignee.id) === String(props.meId),
)

// A current assignee the agent list does not carry is still shown.
const agentOptions = computed(() => {
  const a = props.ticket.assignee
  if (a && !props.agents.some((x) => String(x.id) === String(a.id))) {
    return [{ id: a.id, name: a.name, email: a.email }, ...props.agents]
  }
  return props.agents
})

async function run(action: () => Promise<unknown>, onError: (e: unknown) => void): Promise<void> {
  if (busy.value) return
  busy.value = true
  statusError.value = ''
  actionError.value = ''
  try {
    await action()
    emit('changed')
  } catch (e) {
    onError(e)
  } finally {
    busy.value = false
  }
}

const message = (e: unknown) => (e instanceof ApiError && e.message ? e.message : en.ticket.actionFailed)

function changeStatus(): void {
  const next = statusValue.value as TicketStatus
  if (next === props.ticket.status) return
  void run(
    () => send('setStatus', props.ticket.reference, next),
    (e) => {
      statusValue.value = props.ticket.status
      const refused = e instanceof ApiError && e.status === 422 ? e.errors?.['status']?.[0] : undefined
      if (refused) statusError.value = refused
      else actionError.value = message(e)
    },
  )
}

function changePriority(): void {
  const next = priorityValue.value as TicketPriority
  if (next === props.ticket.priority) return
  void run(
    () => send('setPriority', props.ticket.reference, next),
    (e) => {
      priorityValue.value = props.ticket.priority
      actionError.value = message(e)
    },
  )
}

function revertAssignee(): void {
  assigneeValue.value = props.ticket.assignee ? String(props.ticket.assignee.id) : ''
}

function assignTo(id: number | string): void {
  void run(
    () => send('assign', props.ticket.reference, id as never),
    (e) => {
      revertAssignee()
      actionError.value = message(e)
    },
  )
}

function changeAssignee(): void {
  const agent = agentOptions.value.find((a) => String(a.id) === assigneeValue.value)
  if (!agent || String(agent.id) === String(props.ticket.assignee?.id)) return
  assignTo(agent.id)
}
</script>

<template>
  <div class="triage">
    <div class="grid">
      <label class="field">
        <span class="label">{{ en.ticket.status }}</span>
        <select v-model="statusValue" class="status" :disabled="busy" @change="changeStatus">
          <option v-for="s in STATUSES" :key="s" :value="s">{{ en.ticket.statuses[s] }}</option>
        </select>
      </label>
      <label class="field">
        <span class="label">{{ en.ticket.priority }}</span>
        <select v-model="priorityValue" class="priority" :disabled="busy" @change="changePriority">
          <option v-for="p in PRIORITIES" :key="p" :value="p">{{ en.ticket.priorities[p] }}</option>
        </select>
      </label>
      <label class="field">
        <span class="label">{{ en.ticket.assignee }}</span>
        <select v-model="assigneeValue" class="assignee" :disabled="busy" @change="changeAssignee">
          <option v-if="!ticket.assignee" value="" disabled>{{ en.ticket.notAssigned }}</option>
          <option v-for="a in agentOptions" :key="a.id" :value="String(a.id)">{{ a.name }}</option>
        </select>
      </label>
      <button v-if="!assignedToMe" type="button" class="assign-me" :disabled="busy" @click="assignTo(meId)">
        {{ en.ticket.assignToMe }}
      </button>
    </div>
    <p v-if="statusError" class="status-error" role="alert">{{ statusError }}</p>
    <p v-if="actionError" class="action-error" role="alert">{{ actionError }}</p>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  align-items: end;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.label {
  font-size: 11px;
  color: var(--esc-panel-text-tertiary);
}
select {
  width: 100%;
  min-width: 0;
  padding: 3px 4px;
  font: inherit;
  font-size: 12px;
  color: var(--esc-panel-text);
  background: var(--esc-panel-surface);
  border: 1px solid var(--esc-panel-border-input);
  border-radius: 6px;
}
.assign-me {
  grid-column: 1 / -1;
  justify-self: start;
  padding: 3px 8px;
  font: inherit;
  font-size: 12px;
  color: var(--esc-panel-accent);
  background: transparent;
  border: 1px solid var(--esc-panel-border-input);
  border-radius: 6px;
  cursor: pointer;
}
select:focus-visible,
.assign-me:focus-visible {
  outline: 2px solid var(--esc-panel-accent);
  outline-offset: 1px;
}
select:disabled,
.assign-me:disabled {
  opacity: 0.6;
  cursor: default;
}
.status-error,
.action-error {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--esc-sla-breach);
}
</style>
