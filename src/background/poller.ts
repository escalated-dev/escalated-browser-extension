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
  rebaselineAt: 'poll.rebaselineAt',
  needsReconnect: 'needsReconnect',
} as const

const OVERLAP_MS = 5000
const DEDUPE_MS = 24 * 60 * 60 * 1000
const BACKOFF_MINUTES = [1, 2, 5, 10]
const DEFAULT_RETRY_AFTER_S = 60
const MAX_SNAPSHOT = 2000
const REBASELINE_MS = 60 * 60 * 1000
const MAX_PAGES = 50

type Backoff = { until: number; step: number }
type Snapshot = Record<string, string | null>
type Notified = Record<string, number>
type Client = ReturnType<typeof createClient>

const BADGE_COLOR = '#4f46e5'
const ERROR_COLOR = '#dc2626'

export async function setBadgeCount(n: number): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR })
  await chrome.action.setBadgeText({ text: n <= 0 ? '' : n > 99 ? '99+' : String(n) })
}

export async function setBadgeError(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: ERROR_COLOR })
  await chrome.action.setBadgeText({ text: '!' })
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
  await setBadgeError()
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

/** Every ticket assigned to me, all pages. */
async function listAllMine(client: Client, me: Session['user']['id']): Promise<TicketListItem[]> {
  const out: TicketListItem[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await client.listTickets({ assigned_to: me, per_page: 100, page })
    out.push(...res.data)
    const m = res.meta as { current_page?: number; last_page?: number } | undefined
    if (!m?.last_page || (m.current_page ?? page) >= m.last_page) break
  }
  return out
}

async function run(now: Date): Promise<void> {
  const session = await getSession()
  if (!session) return
  const st = await chrome.storage.local.get(Object.values(KEYS))
  const backoff = st[KEYS.backoff] as Backoff | undefined
  if (backoff && now.getTime() < backoff.until) return

  const client = createClient(session.apiBase, session.token)
  const me = session.user.id
  const features = session.meta.features
  const canSince = features.includes('tickets.updated_since')
  const canReply = features.includes('tickets.last_customer_reply_at')
  const since = st[KEYS.lastPollAt] as string | undefined
  const lastRebaseline = st[KEYS.rebaselineAt] as number | undefined
  // The full listing runs on the first poll, hourly (drops tickets that are no longer mine, so a
  // later re-assignment alerts; a round trip inside one hour is still missed), and on every poll
  // when the helpdesk cannot filter by updated_since.
  const full =
    since === undefined ||
    !canSince ||
    lastRebaseline === undefined ||
    now.getTime() - lastRebaseline >= REBASELINE_MS
  try {
    const [dash, mine, free] = await Promise.all([
      client.dashboard(),
      full
        ? listAllMine(client, me)
        : client.listTickets({ assigned_to: me, updated_since: since, per_page: 100 }).then((r) => r.data),
      full
        ? Promise.resolve([] as TicketListItem[])
        : client.listTickets({ unassigned: true, updated_since: since, per_page: 100 }).then((r) => r.data),
    ])
    if (!(await stillCurrent(session))) return

    const snapshot = { ...((st[KEYS.snapshot] as Snapshot | undefined) ?? {}) }
    const notified = pruneNotified((st[KEYS.notified] as Notified | undefined) ?? {}, now)
    const baseline = since === undefined
    const sinceMs = since === undefined ? NaN : Date.parse(since)

    if (full) {
      const mineRefs = new Set(mine.map((t) => t.reference))
      for (const [ref, owner] of Object.entries(snapshot)) {
        if (sameId(owner, me) && !mineRefs.has(ref)) delete snapshot[ref]
      }
    }

    const alerts: { kind: 'assigned' | 'reply'; ticket: TicketListItem; key: string }[] = []
    for (const t of mine) {
      if (!sameId(t.assignee?.id, me)) continue
      const wasMine = sameId(snapshot[t.reference], me)
      // Delete then insert so recently touched keys sit last and survive trimming.
      delete snapshot[t.reference]
      snapshot[t.reference] = String(me)
      if (baseline) continue
      if (!wasMine) {
        alerts.push({ kind: 'assigned', ticket: t, key: `${t.reference}|${t.updated_at}|assigned` })
      } else if (canReply && time(t.last_customer_reply_at) > sinceMs) {
        alerts.push({
          kind: 'reply',
          ticket: t,
          key: `${t.reference}|${t.last_customer_reply_at}|reply`,
        })
      }
    }
    // A missing key already means "not mine"; only tickets we knew about need the update.
    for (const t of free) if (t.reference in snapshot) snapshot[t.reference] = null

    for (const a of alerts) {
      if (a.key in notified) continue
      notified[a.key] = now.getTime()
      try {
        await notifyTicket(a.kind, a.ticket)
      } catch {
        // A failed alert must not look like a network error and stall polling.
      }
    }

    await setBadgeCount(dash.stats.my_assigned)
    await chrome.storage.local.set({
      [KEYS.snapshot]: trimSnapshot(snapshot),
      [KEYS.notified]: notified,
      [KEYS.lastPollAt]: stamp(now),
      ...(full ? { [KEYS.rebaselineAt]: now.getTime() } : {}),
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
