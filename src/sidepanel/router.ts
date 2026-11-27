import { reactive } from 'vue'

export type ViewName = 'connect' | 'queue' | 'ticket' | 'create'

export const router = reactive<{ view: ViewName; currentReference?: string }>({ view: 'queue' })

export function showQueue(): void {
  router.view = 'queue'
  delete router.currentReference
}

export function openTicket(reference: string): void {
  router.currentReference = reference
  router.view = 'ticket'
}

export function showCreate(): void {
  router.view = 'create'
}
