import type { Session } from '../api/client'

const KEY = 'session'

/** The panel keeps the last helpdesk address in its localStorage to prefill a reconnect. */
export const LAST_ADDRESS_KEY = 'lastAddress'

/**
 * Restricts chrome.storage.local to extension contexts. Older Chrome versions in the supported
 * range reject this for the local area or lack the method. The extension has no content scripts,
 * so local storage is already reachable only from its own pages and worker: a failure is ignored.
 */
export async function restrictStorage(): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
  } catch {
    // Not supported here; see above.
  }
}

export async function getSession(): Promise<Session | null> {
  const got = await chrome.storage.local.get(KEY)
  return (got[KEY] as Session | undefined) ?? null
}

export async function setSession(s: Session): Promise<void> {
  await restrictStorage()
  await chrome.storage.local.set({ [KEY]: s })
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.clear()
}
