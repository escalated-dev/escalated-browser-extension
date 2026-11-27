import type { Session } from '../api/client'

const KEY = 'session'

/** The token lives only in chrome.storage.local, restricted to extension contexts. */
async function restrict(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
}

export async function getSession(): Promise<Session | null> {
  const got = await chrome.storage.local.get(KEY)
  return (got[KEY] as Session | undefined) ?? null
}

export async function setSession(s: Session): Promise<void> {
  await restrict()
  await chrome.storage.local.set({ [KEY]: s })
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.clear()
}
