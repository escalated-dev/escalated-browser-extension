import type { TicketListItem } from '../api/client'
import type { OpenTicketMessage } from './messages'

export type NotifyKind = 'assigned' | 'reply'

export const PENDING_OPEN_KEY = 'pendingOpen'

export async function notifyTicket(kind: NotifyKind, t: TicketListItem): Promise<void> {
  const lead = kind === 'assigned' ? 'Assigned to you' : 'Customer replied'
  await chrome.notifications.create(t.reference, {
    type: 'basic',
    iconUrl: 'icons/48.png',
    title: 'Escalated',
    message: `${lead}: #${t.reference} ${t.subject}`,
  })
}

/** The notification id is the ticket reference. */
export async function onNotificationClicked(reference: string): Promise<void> {
  await chrome.notifications.clear(reference).catch(() => undefined)
  try {
    const win = await chrome.windows.getLastFocused()
    if (win.id !== undefined) await chrome.sidePanel.open({ windowId: win.id })
  } catch {
    // The panel may already be open, or the browser may refuse; the message below still goes out.
  }
  try {
    await chrome.runtime.sendMessage({ type: 'open-ticket', reference } satisfies OpenTicketMessage)
  } catch {
    // Nobody is listening: the panel is not open yet. It reads this on load.
    await chrome.storage.session.set({ [PENDING_OPEN_KEY]: { reference, at: Date.now() } })
  }
}
