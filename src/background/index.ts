import { getSession } from '../state/storage'
import { handleMessage } from './router'
import type { ApiResponse } from './messages'
import { registerContextMenu, syncContextMenu } from './contextMenu'
import { onNotificationClicked, trackFocusedWindow } from './notify'
import { ALARM, ensureAlarm, KEYS, poll, resetPollState, setBadgeError } from './poller'

async function init(force: boolean): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    await ensureAlarm(force)
    await syncContextMenu()
    if (!(await getSession())) {
      const flag = await chrome.storage.local.get(KEYS.needsReconnect)
      if (flag[KEYS.needsReconnect]) await setBadgeError()
    }
  } catch {
    // Nothing useful to do; the next start retries.
  }
}

// Listeners are registered synchronously at the top level (MV3 requirement).
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
trackFocusedWindow()
registerContextMenu()

chrome.runtime.onStartup.addListener(() => void init(true))
chrome.runtime.onInstalled.addListener(() => void init(true))

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void poll()
})

chrome.notifications.onClicked.addListener((id) => void onNotificationClicked(id))

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const pending = handleMessage(msg, sender)
  if (!pending) return false
  void pending
    .catch((): ApiResponse => ({ ok: false, error: { status: 0, message: 'Worker error' } }))
    .then(sendResponse)
  return true
})

// A session appearing (the panel connected) starts a fresh baseline and the alarm.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.session?.newValue) return
  void (async () => {
    await resetPollState()
    await chrome.action.setBadgeText({ text: '' })
    await ensureAlarm(true)
    await poll()
  })().catch(() => undefined)
})

void init(false)
