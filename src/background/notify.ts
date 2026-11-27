import type { TicketListItem } from '../api/client'
import type { OpenTicketMessage } from './messages'

export type NotifyKind = 'assigned' | 'reply'

export const PENDING_OPEN_KEY = 'pendingOpen'

let focusedWindowId: number | undefined

export function setFocusedWindowId(id: number | undefined): void {
  focusedWindowId = id
}

/**
 * The notification id carries the ticket reference and the window that was focused when it was
 * shown, as "reference|windowId". A click that wakes a stopped worker has no focus history in
 * memory, and sidePanel.open must run before the first await, so the id is the only source.
 */
export function notificationId(reference: string, windowId: number | undefined): string {
  return windowId === undefined ? reference : `${reference}|${windowId}`
}

export function parseNotificationId(id: string): { reference: string; windowId?: number } {
  const i = id.lastIndexOf('|')
  if (i < 0) return { reference: id }
  const windowId = Number(id.slice(i + 1))
  if (id.slice(i + 1) === '' || !Number.isInteger(windowId)) return { reference: id }
  return { reference: id.slice(0, i), windowId }
}

export async function notifyTicket(kind: NotifyKind, t: TicketListItem): Promise<void> {
  const lead = kind === 'assigned' ? 'Assigned to you' : 'Customer replied'
  let windowId = focusedWindowId
  if (windowId === undefined) {
    windowId = await chrome.windows.getLastFocused().then(
      (w) => w.id,
      () => undefined,
    )
  }
  await chrome.notifications.create(notificationId(t.reference, windowId), {
    type: 'basic',
    iconUrl: 'icons/48.png',
    title: 'Escalated',
    message: `${lead}: #${t.reference} ${t.subject}`,
  })
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
 * sidePanel.open needs the click's user gesture, so it is called before the first await whenever
 * a window id is known: the focused window, else the one stored in the notification id.
 */
export async function onNotificationClicked(id: string): Promise<void> {
  const { reference, windowId } = parseNotificationId(id)
  const known = focusedWindowId ?? windowId
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
  await chrome.notifications.clear(id).catch(() => undefined)
  try {
    await chrome.runtime.sendMessage({ type: 'open-ticket', reference } satisfies OpenTicketMessage)
  } catch {
    // Nobody is listening: the panel is not open yet. It reads this on load.
    await chrome.storage.session.set({ [PENDING_OPEN_KEY]: { reference, at: Date.now() } })
  }
}
