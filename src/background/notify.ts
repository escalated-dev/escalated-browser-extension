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

let focusedWindowId: number | undefined

export function setFocusedWindowId(id: number | undefined): void {
  focusedWindowId = id
}

/** Top level, synchronous: the click handler needs the window id without awaiting. */
export function trackFocusedWindow(): void {
  chrome.windows.onFocusChanged.addListener((id) => {
    if (id !== chrome.windows.WINDOW_ID_NONE) focusedWindowId = id
  })
  void chrome.windows
    .getLastFocused()
    .then((w) => {
      focusedWindowId ??= w.id
    })
    .catch(() => undefined)
}

/**
 * The notification id is the ticket reference. sidePanel.open needs the click's user gesture,
 * so it is called before the first await whenever the window id is known.
 */
export async function onNotificationClicked(reference: string): Promise<void> {
  const known = focusedWindowId
  if (known !== undefined) {
    await chrome.sidePanel.open({ windowId: known }).catch(() => undefined)
  } else {
    try {
      const win = await chrome.windows.getLastFocused()
      if (win.id !== undefined) await chrome.sidePanel.open({ windowId: win.id })
    } catch {
      // Best effort: the gesture may already be gone.
    }
  }
  await chrome.notifications.clear(reference).catch(() => undefined)
  try {
    await chrome.runtime.sendMessage({ type: 'open-ticket', reference } satisfies OpenTicketMessage)
  } catch {
    // Nobody is listening: the panel is not open yet. It reads this on load.
    await chrome.storage.session.set({ [PENDING_OPEN_KEY]: { reference, at: Date.now() } })
  }
}
