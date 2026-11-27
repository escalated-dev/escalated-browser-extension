<script lang="ts">
export default { name: 'TicketThread' }
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { Reply } from '@/api/client'
import { en } from '@/i18n/en'
import { relativeTime } from '../time'

const props = defineProps<{ replies: Reply[]; requesterName: string }>()

const root = ref<HTMLElement | null>(null)

// The contract sends latest first; the thread reads oldest to newest.
const ordered = computed(() => [...props.replies].reverse())
const newestId = computed(() => ordered.value.at(-1)?.id)

function author(r: Reply): string {
  return r.author?.name || props.requesterName || en.ticket.unknownAuthor
}

async function toBottom(): Promise<void> {
  await nextTick()
  const last = root.value?.querySelector('.message:last-child')
  if (last && typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'end' })
}

onMounted(toBottom)
watch(newestId, toBottom)
</script>

<template>
  <section ref="root" class="thread" :aria-label="en.ticket.thread">
    <p v-if="ordered.length === 0" class="empty">{{ en.ticket.noMessages }}</p>
    <article v-for="r in ordered" :key="r.id" class="message" :class="{ note: r.is_internal_note }">
      <header class="meta">
        <span class="author">{{ author(r) }}</span>
        <span v-if="r.is_internal_note" class="tag">{{ en.ticket.internalNote }}</span>
        <time class="time" :datetime="r.created_at">{{ relativeTime(r.created_at) }}</time>
      </header>
      <div class="body">{{ r.body }}</div>
    </article>
  </section>
</template>

<style scoped>
.thread {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}
.empty {
  margin: 0;
  text-align: center;
  color: var(--esc-panel-text-tertiary);
  font-size: 12px;
}
.message {
  padding: 8px 10px;
  background: var(--esc-panel-surface);
  border: 1px solid var(--esc-panel-border);
  border-radius: 8px;
}
.message.note {
  background: var(--esc-panel-note-bg);
  border-color: var(--esc-panel-note-border);
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--esc-panel-text-tertiary);
}
.author {
  font-weight: 600;
  color: var(--esc-panel-text-secondary);
}
.tag {
  padding: 0 5px;
  font-weight: 600;
  color: var(--esc-panel-note-text);
  border: 1px solid var(--esc-panel-note-border);
  border-radius: 4px;
}
.time {
  margin-left: auto;
}
.body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
}
</style>
