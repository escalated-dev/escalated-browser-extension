import { reactive } from 'vue'

export type ViewName = 'connect' | 'queue' | 'ticket' | 'create'

export type CreatePrefill = { selection?: string; title?: string; url?: string }

export const router = reactive<{
  view: ViewName
  currentReference?: string
  createPrefill?: CreatePrefill
}>({ view: 'queue' })

export function showQueue(): void {
  router.view = 'queue'
  delete router.currentReference
  delete router.createPrefill
}

export function openTicket(reference: string): void {
  router.currentReference = reference
  delete router.createPrefill
  router.view = 'ticket'
}

export function showCreate(prefill?: CreatePrefill): void {
  if (prefill) router.createPrefill = prefill
  else delete router.createPrefill
  router.view = 'create'
}
