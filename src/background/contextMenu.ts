import { getSession } from '../state/storage'

export const MENU_ID = 'create-ticket'
export const PENDING_CREATE_KEY = 'pendingCreate'
export const MENU_TITLE = 'Create Escalated ticket'

const SELECTION_MAX = 10_000

export type PendingCreate = { selection: string; title: string; url: string; at: number }

type MenuInfo = { menuItemId?: string | number; selectionText?: string; pageUrl?: string }
type MenuTab = { id?: number; title?: string; url?: string }

let chain: Promise<void> = Promise.resolve()

async function doSync(): Promise<void> {
  const session = await getSession()
  // Menus do not reliably survive a worker restart, so always rebuild from scratch.
  await chrome.contextMenus.removeAll()
  if (!session || !session.meta.features.includes('tickets.create')) return
  await new Promise<void>((resolve) => {
    chrome.contextMenus.create({ id: MENU_ID, title: MENU_TITLE, contexts: ['selection', 'page'] }, () => {
      void chrome.runtime.lastError
      resolve()
    })
  })
}

/** Serialised so overlapping syncs cannot try to create the same id twice. */
export function syncContextMenu(): Promise<void> {
  const next = chain.then(doSync, doSync)
  chain = next.catch(() => undefined)
  return next.catch(() => undefined)
}

function httpUrl(raw: string | undefined): string {
  if (!raw) return ''
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? raw : ''
  } catch {
    return ''
  }
}

/** Chrome scrubs tab.title without host access: fall back to the selection, then the hostname. */
function pickTitle(tabTitle: string | undefined, selection: string, url: string): string {
  const own = (tabTitle ?? '').trim()
  if (own) return own
  const line = selection
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (line) return line.slice(0, 255)
  try {
    return url ? new URL(url).hostname : ''
  } catch {
    return ''
  }
}

export function buildPending(info: MenuInfo, tab: MenuTab | undefined): PendingCreate {
  const selection = (info.selectionText ?? '').slice(0, SELECTION_MAX)
  const url = httpUrl(info.pageUrl ?? tab?.url)
  return { selection, title: pickTitle(tab?.title, selection, url), url, at: Date.now() }
}

function onMenuClicked(info: MenuInfo, tab?: MenuTab): void {
  if (info.menuItemId !== MENU_ID) return
  // The click is a user gesture: open the panel before anything is awaited.
  if (tab?.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined)
  void chrome.storage.session.set({ [PENDING_CREATE_KEY]: buildPending(info, tab) }).catch(() => undefined)
}

/** Top level, synchronous. */
export function registerContextMenu(): void {
  chrome.contextMenus.onClicked.addListener(onMenuClicked as never)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'session' in changes) void syncContextMenu()
  })
  void syncContextMenu()
}
