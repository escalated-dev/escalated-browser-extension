<script setup lang="ts">
import { computed } from 'vue'
import type { TicketListItem } from '@/api/client'
import { en } from '@/i18n/en'
import { relativeTime } from '../time'

const props = defineProps<{ ticket: TicketListItem }>()
defineEmits<{ open: [reference: string] }>()

const requester = computed(
  () => props.ticket.requester.name || props.ticket.requester.email || en.queue.noRequester,
)
const activity = computed(
  () => relativeTime(props.ticket.last_reply_at ?? props.ticket.updated_at) || en.queue.noActivity,
)
</script>

<template>
  <button
    type="button"
    class="row"
    :data-reference="ticket.reference"
    @click="$emit('open', ticket.reference)"
  >
    <span class="line">
      <span class="ref">#{{ ticket.reference }}</span>
      <span
        v-if="ticket.sla_breached"
        class="sla"
        role="img"
        :aria-label="en.queue.slaBreached"
        :title="en.queue.slaBreached"
      ></span>
      <span class="time">{{ activity }}</span>
    </span>
    <span class="subject">{{ ticket.subject }}</span>
    <span class="line meta">
      <span class="requester">{{ requester }}</span>
      <span class="priority" :data-priority="ticket.priority">{{ ticket.priority_label }}</span>
    </span>
  </button>
</template>

<style scoped>
.row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
  background: transparent;
  color: var(--esc-panel-text);
  border: 0;
  border-bottom: 1px solid var(--esc-panel-border);
  cursor: pointer;
  font: inherit;
}
.row:hover {
  background: var(--esc-panel-hover);
}
.row:focus-visible {
  outline: 2px solid var(--esc-panel-accent);
  outline-offset: -2px;
}
.line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--esc-panel-text-tertiary);
}
.ref {
  font-weight: 600;
  color: var(--esc-panel-text-secondary);
}
.time {
  margin-left: auto;
}
.subject {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  justify-content: space-between;
}
.requester {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sla {
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  background: var(--esc-sla-breach);
  flex: none;
}
.priority {
  flex: none;
  font-weight: 600;
}
.priority[data-priority='low'] {
  color: var(--esc-priority-low);
}
.priority[data-priority='medium'] {
  color: var(--esc-priority-medium);
}
.priority[data-priority='high'] {
  color: var(--esc-priority-high);
}
.priority[data-priority='urgent'] {
  color: var(--esc-priority-urgent);
}
</style>
