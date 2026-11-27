<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { CreateTicketInput, Department, Session } from '@/api/client'
import { ApiError } from '@/api/errors'
import { send } from '@/background/messages'
import { en } from '@/i18n/en'
import { openTicket, showQueue, type CreatePrefill } from '../router'

const props = defineProps<{ session: Session; prefill?: CreatePrefill | undefined }>()

const SUBJECT_MAX = 255
const DESCRIPTION_MAX = 65535
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PRIORITIES = ['low', 'medium', 'high', 'urgent', 'critical'] as const

type Field = 'subject' | 'description' | 'email' | 'name' | 'priority' | 'department'

function initialDescription(): string {
  const parts = [props.prefill?.selection?.trim() ?? '', props.prefill?.url ?? ''].filter(Boolean)
  return parts.join('\n\n').slice(0, DESCRIPTION_MAX)
}

const form = reactive({
  subject: (props.prefill?.title ?? '').trim().slice(0, SUBJECT_MAX),
  description: initialDescription(),
  email: '',
  name: '',
  priority: '',
  department: '',
})
const departments = ref<Department[]>([])
const busy = ref(false)
const errors = reactive<Partial<Record<Field, string>>>({})
const formError = ref('')

const activeDepartments = computed(() => departments.value.filter((d) => d.is_active))

onMounted(async () => {
  try {
    const res = await send('departments')
    if (Array.isArray(res?.data)) departments.value = res.data
  } catch {
    // The field is simply hidden when departments are unavailable.
  }
})

function clearErrors(): void {
  for (const k of Object.keys(errors) as Field[]) delete errors[k]
  formError.value = ''
}

function validate(): boolean {
  clearErrors()
  if (!form.subject.trim()) errors.subject = en.create.subjectRequired
  if (!form.description.trim()) errors.description = en.create.descriptionRequired
  const email = form.email.trim()
  if (!email) errors.email = en.create.emailRequired
  else if (!EMAIL_RE.test(email)) errors.email = en.create.emailInvalid
  return Object.keys(errors).length === 0
}

const FIELD_FOR_KEY: Record<string, Field> = {
  subject: 'subject',
  description: 'description',
  requester: 'email',
  'requester.email': 'email',
  'requester.name': 'name',
  priority: 'priority',
  department_id: 'department',
}

function applyServerErrors(all: Record<string, string[]>): void {
  const general: string[] = []
  for (const [key, messages] of Object.entries(all)) {
    const text = messages.join(' ')
    const field = FIELD_FOR_KEY[key]
    if (field) errors[field] = text
    else general.push(text)
  }
  formError.value = general.join(' ')
}

async function submit(): Promise<void> {
  if (busy.value) return
  if (!validate()) return
  busy.value = true
  const email = form.email.trim()
  const body: CreateTicketInput = {
    subject: form.subject.trim().slice(0, SUBJECT_MAX),
    description: form.description,
    requester: { name: form.name.trim() || (email.split('@')[0] ?? email), email },
  }
  if (form.priority) body.priority = form.priority as (typeof PRIORITIES)[number]
  if (form.department) body.department_id = Number(form.department)
  try {
    const res = await send('createTicket', body)
    const reference = res?.data?.reference
    if (typeof reference !== 'string' || !reference) throw new ApiError(en.create.failed, 0)
    openTicket(reference)
  } catch (e) {
    if (e instanceof ApiError && e.status === 422 && e.errors && Object.keys(e.errors).length > 0) {
      applyServerErrors(e.errors)
      if (!formError.value && Object.keys(errors).length === 0) formError.value = e.message
    } else {
      formError.value = e instanceof ApiError && e.message ? e.message : en.create.failed
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="create" novalidate @submit.prevent="submit">
    <div class="top">
      <button type="button" class="cancel" @click="showQueue">{{ en.create.cancel }}</button>
      <h1 class="title">{{ en.create.title }}</h1>
    </div>

    <div class="field" data-field="subject">
      <label for="create-subject">{{ en.create.subject }}</label>
      <input
        id="create-subject"
        v-model="form.subject"
        class="subject"
        type="text"
        :maxlength="SUBJECT_MAX"
        :aria-invalid="errors.subject ? 'true' : undefined"
      />
      <p v-if="errors.subject" class="field-error" role="alert">{{ errors.subject }}</p>
    </div>

    <div class="field" data-field="description">
      <label for="create-description">{{ en.create.description }}</label>
      <textarea
        id="create-description"
        v-model="form.description"
        class="description"
        rows="8"
        :maxlength="DESCRIPTION_MAX"
        :aria-invalid="errors.description ? 'true' : undefined"
      ></textarea>
      <p v-if="errors.description" class="field-error" role="alert">{{ errors.description }}</p>
    </div>

    <div class="field" data-field="email">
      <label for="create-email">{{ en.create.email }}</label>
      <input
        id="create-email"
        v-model="form.email"
        class="email"
        type="email"
        autocomplete="off"
        :aria-invalid="errors.email ? 'true' : undefined"
      />
      <p v-if="errors.email" class="field-error" role="alert">{{ errors.email }}</p>
    </div>

    <div class="field" data-field="name">
      <label for="create-name">{{ en.create.name }}</label>
      <input id="create-name" v-model="form.name" class="name" type="text" autocomplete="off" />
      <p v-if="errors.name" class="field-error" role="alert">{{ errors.name }}</p>
    </div>

    <div class="row">
      <div class="field" data-field="priority">
        <label for="create-priority">{{ en.create.priority }}</label>
        <select id="create-priority" v-model="form.priority" class="priority">
          <option value="">{{ en.create.priorityDefault }}</option>
          <option v-for="p in PRIORITIES" :key="p" :value="p">{{ en.ticket.priorities[p] }}</option>
        </select>
        <p v-if="errors.priority" class="field-error" role="alert">{{ errors.priority }}</p>
      </div>

      <div v-if="activeDepartments.length > 0" class="field" data-field="department">
        <label for="create-department">{{ en.create.department }}</label>
        <select id="create-department" v-model="form.department" class="department">
          <option value="">{{ en.create.departmentNone }}</option>
          <option v-for="d in activeDepartments" :key="d.id" :value="String(d.id)">{{ d.name }}</option>
        </select>
        <p v-if="errors.department" class="field-error" role="alert">{{ errors.department }}</p>
      </div>
    </div>

    <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>

    <button type="submit" class="submit" :disabled="busy">
      {{ busy ? en.create.submitting : en.create.submit }}
    </button>
  </form>
</template>

<style scoped>
.create {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px 14px;
}
.top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.cancel {
  font: inherit;
  font-size: 12px;
  color: var(--esc-panel-accent);
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}
.row {
  display: flex;
  gap: 10px;
}
.row .field {
  flex: 1;
  min-width: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
label {
  font-size: 12px;
  color: var(--esc-panel-text-secondary);
}
input,
textarea,
select {
  font: inherit;
  font-size: 13px;
  color: var(--esc-panel-text);
  background: var(--esc-panel-surface);
  border: 1px solid var(--esc-panel-border-input);
  border-radius: 6px;
  padding: 5px 7px;
  min-width: 0;
}
textarea {
  resize: vertical;
}
input[aria-invalid='true'],
textarea[aria-invalid='true'] {
  border-color: var(--esc-sla-breach);
}
input:focus-visible,
textarea:focus-visible,
select:focus-visible,
.cancel:focus-visible,
.submit:focus-visible {
  outline: 2px solid var(--esc-panel-accent);
  outline-offset: 1px;
}
.field-error,
.form-error {
  margin: 0;
  font-size: 12px;
  color: var(--esc-sla-breach);
}
.submit {
  font: inherit;
  font-size: 13px;
  align-self: flex-start;
  color: var(--esc-panel-primary-text);
  background: var(--esc-panel-primary-bg);
  border: 1px solid var(--esc-panel-primary-bg);
  border-radius: 6px;
  padding: 5px 12px;
  cursor: pointer;
}
.submit:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
