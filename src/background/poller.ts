import { ApiError } from '../api/errors'
import { createClient, type Session, type TicketListItem } from '../api/client'
import { clearSession, getSession } from '../state/storage'
import { notifyTicket } from './notify'

export const ALARM = 'poll'

/** Everything here lives in chrome.storage.local so it survives worker and browser restarts. */
export const KEYS = {
  lastPollAt: 'poll.lastPollAt',
  snapshot: 'poll.snapshot',
  backoff: 'poll.backoff',
  notified: 'poll.notified',
  needsReconnect: 'needsReconnect',
} as const

const OVERLAP_MS = 5000
const DEDUPE_MS = 24 * 60 * 60 * 1000
const BACKOFF_MINUTES = [1, 2, 5, 10]
const DEFAULT_RETRY_AFTER_S = 60
const MAX_SNAPSHOT = 2000

type Backoff = { until: number; step: number }
type Snapshot = Record<string, string | null>
type Notified = Record<string, number>

const BADGE_COLOR = '#4f46e5'
const ERROR_COLOR = '#dc2626'

export async function setBadgeCount(n: number): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR })
  await chrome.action.setBadgeText({ text: n <= 0 ? '' : n > 99 ? '99+' : String(n) })
}

export async function ensureAlarm(force = false): Promise<void> {
  if (!(await getSession())) return
  if (!force && (await chrome.alarms.get(ALARM))) return
  await chrome.alarms.create(ALARM, { periodInMinutes: 1 })
}

/** Local only: the token is already dead, so the server is not called. */
export async function handleUnauthorized(): Promise<void> {
  await clearSession()
  await chrome.alarms.clear(ALARM)
  await chrome.storage.local.set({ [KEYS.needsReconnect]: true })
  await chrome.action.setBadgeBackgroundColor({ color: ERROR_COLOR })
  await chrome.action.setBadgeText({ text: '!' })
}

/** A new session starts from scratch: new baseline, no stale backoff, no reconnect flag. */
export async function resetPollState(): Promise<void> {
  await chrome.storage.local.remove(Object.values(KEYS))
}

const sameId = (a: unknown, b: unknown) => a !== undefined && a !== null && String(a) === String(b)
const time = (v: string | null | undefined) => (v ? Date.parse(v) : NaN)
const stamp = (now: Date) => new Date(now.getTime() - OVERLAP_MS).toISOString()

let running: Promise<void> | null = null

/** One poll. Concurrent calls share the run in flight. */
export function poll(now: Date = new Date()): Promise<void> {
  running ??= run(now).finally(() => {
    running = null
  })
  return running
}

async function run(now: Date): Promise<void> {
  const session = await getSession()
  if (!session) return
  const st = await chrome.storage.local.get(Object.values(KEYS))
  const backoff = st[KEYS.backoff] as Backoff | undefined
  if (backoff && now.getTime() < backoff.until) return

  const client = createClient(session.apiBase, session.token)
  const me = session.user.id
  const since = st[KEYS.lastPollAt] as string | undefined
  try {
    if (since === undefined) {
      // First poll after connect: record who owns what, notify nothing.
      const [dash, mine] = await Promise.all([
        client.dashboard(),
        client.listTickets({ assigned_to: me, per_page: 100 }),
      ])
      if (!(await stillCurrent(session))) return
      const snapshot: Snapshot = {}
      for (const t of mine.data) if (sameId(t.assignee?.id, me)) snapshot[t.reference] = String(me)
      await setBadgeCount(dash.stats.my_assigned)
      await chrome.storage.local.set({ [KEYS.snapshot]: snapshot, [KEYS.lastPollAt]: stamp(now) })
      await chrome.storage.local.remove(KEYS.backoff)
      return
    }

    const [dash, mine, free] = await Promise.all([
      client.dashboard(),
      client.listTickets({ assigned_to: me, updated_since: since, per_page: 100 }),
      client.listTickets({ unassigned: true, updated_since: since, per_page: 100 }),
    ])
    if (!(await stillCurrent(session))) return

    const snapshot = { ...((st[KEYS.snapshot] as Snapshot | undefined) ?? {}) }
    const notified = pruneNotified((st[KEYS.notified] as Notified | undefined) ?? {}, now)
    const sinceMs = Date.parse(since)

    const alerts: { kind: 'assigned' | 'reply'; ticket: TicketListItem }[] = []
    for (const t of mine.data) {
      if (!sameId(t.assignee?.id, me)) continue
      const wasMine = sameId(snapshot[t.reference], me)
      snapshot[t.reference] = String(me)
      if (!wasMine) alerts.push({ kind: 'assigned', ticket: t })
      else if (time(t.last_customer_reply_at) > sinceMs) alerts.push({ kind: 'reply', ticket: t })
    }
    for (const t of free.data) snapshot[t.reference] = null

    for (const a of alerts) {
      const key = `${a.ticket.reference}|${a.ticket.updated_at}|${a.kind}`
      if (key in notified) continue
      notified[key] = now.getTime()
      await notifyTicket(a.kind, a.ticket)
    }

    await setBadgeCount(dash.stats.my_assigned)
    await chrome.storage.local.set({
      [KEYS.snapshot]: trimSnapshot(snapshot),
      [KEYS.notified]: notified,
      [KEYS.lastPollAt]: stamp(now),
    })
    await chrome.storage.local.remove(KEYS.backoff)
  } catch (e) {
    if (!(await stillCurrent(session))) return
    if (e instanceof ApiError && e.status === 401) return handleUnauthorized()
    const prev = backoff?.step ?? 0
    if (e instanceof ApiError && e.status === 429) {
      const wait = (e.retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000
      await chrome.storage.local.set({ [KEYS.backoff]: { until: now.getTime() + wait, step: prev } })
      return
    }
    const minutes = BACKOFF_MINUTES[Math.min(prev, BACKOFF_MINUTES.length - 1)]!
    await chrome.storage.local.set({
      [KEYS.backoff]: { until: now.getTime() + minutes * 60_000, step: prev + 1 },
    })
  }
}

/** False when the user disconnected or switched helpdesk while a request was in flight. */
async function stillCurrent(session: Session): Promise<boolean> {
  const now = await getSession()
  return now !== null && now.token === session.token && now.apiBase === session.apiBase
}

function pruneNotified(n: Notified, now: Date): Notified {
  const out: Notified = {}
  for (const [k, at] of Object.entries(n)) if (now.getTime() - at < DEDUPE_MS) out[k] = at
  return out
}

function trimSnapshot(s: Snapshot): Snapshot {
  const keys = Object.keys(s)
  if (keys.length <= MAX_SNAPSHOT) return s
  return Object.fromEntries(keys.slice(keys.length - MAX_SNAPSHOT).map((k) => [k, s[k]!]))
}
