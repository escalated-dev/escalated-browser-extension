import { ApiError } from '../api/errors'
import {
  createClient,
  type FetchLike,
  type Session,
  type TicketListItem,
  type TicketQuery,
} from '../api/client'
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
  /** Set while the helpdesk answers 403; the panel shows it. */
  forbidden: 'poll.forbidden',
  needsReconnect: 'needsReconnect',
} as const

const OVERLAP_MS = 5000
const DEDUPE_MS = 24 * 60 * 60 * 1000
const BACKOFF_MINUTES = [1, 2, 5, 10]
const DEFAULT_RETRY_AFTER_S = 60
const MAX_SNAPSHOT = 2000
const REBASELINE_MS = 60 * 60 * 1000
/** Pages of 100 in a full "mine" listing. Open tickets only when the helpdesk can filter them. */
const MAX_PAGES_OPEN = 20
const MAX_PAGES_FALLBACK = 5

type Backoff = { until: number; step: number }
/** Who each known ticket belongs to (null: nobody) and when a poll last saw it. */
export type SnapshotEntry = { owner: string | null; seen: number }
type Snapshot = Record<string, SnapshotEntry>
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

/** Read the HTTP Date header; undefined when missing or unparseable. */
function headerDate(res: Response): number | undefined {
  const ms = Date.parse(res.headers.get('Date') ?? '')
  return Number.isFinite(ms) ? ms : undefined
}

let lock: Promise<unknown> = Promise.resolve()

/** Runs fn after everything queued before it: polls and snapshot writes never interleave. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn)
  lock = next.catch(() => undefined)
  return next
}

let running: Promise<void> | null = null

/** One poll. Concurrent calls share the run in flight. */
export function poll(now: Date = new Date()): Promise<void> {
  running ??= exclusive(() => run(now)).finally(() => {
    running = null
  })
  return running
}

/** References the agent is assigning to themselves right now, so a poll in flight stays quiet. */
const expected = new Set<string>()

export function expectMine(reference: string): void {
  expected.add(reference)
}

export function forgetExpected(reference: string): void {
  expected.delete(reference)
}

/**
 * The panel assigned (or created) this ticket for the signed-in agent: record it as already mine,
 * so the next poll does not announce "Assigned to you" for the agent's own action.
 */
export function recordMine(reference: string, now: Date = new Date()): Promise<void> {
  return exclusive(async () => {
    try {
      const session = await getSession()
      if (!session) return
      const st = await chrome.storage.local.get(KEYS.snapshot)
      const snapshot = readSnapshot(st[KEYS.snapshot])
      snapshot[reference] = { owner: String(session.user.id), seen: now.getTime() }
      await chrome.storage.local.set({ [KEYS.snapshot]: trimSnapshot(snapshot) })
    } finally {
      expected.delete(reference)
    }
  })
}

type Listing = { tickets: TicketListItem[]; complete: boolean }

/** Tickets assigned to me, newest activity first, up to `maxPages` pages. */
async function listMine(client: Client, query: TicketQuery, maxPages: number): Promise<Listing> {
  const tickets: TicketListItem[] = []
  for (let page = 1; page <= maxPages; page++) {
    const res = await client.listTickets({
      ...query,
      sort_by: 'updated_at',
      sort_dir: 'desc',
      per_page: 100,
      page,
    })
    tickets.push(...res.data)
    const m = res.meta as { current_page?: number; last_page?: number } | undefined
    if (!m?.last_page || (m.current_page ?? page) >= m.last_page) return { tickets, complete: true }
  }
  return { tickets, complete: false }
}

async function run(now: Date): Promise<void> {
  const session = await getSession()
  if (!session) return
  const st = await chrome.storage.local.get(Object.values(KEYS))
  const backoff = st[KEYS.backoff] as Backoff | undefined
  if (backoff && now.getTime() < backoff.until) return

  // The next updated_since comes from the helpdesk's clock (the list responses' Date header), so
  // a client clock that runs ahead cannot skip updates. The earliest list response wins.
  let serverNow: number | undefined
  const fetchImpl: FetchLike = async (input, init) => {
    const res = await fetch(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const at = /\/tickets(\?|$)/.test(url) ? headerDate(res) : undefined
    if (at !== undefined) serverNow = serverNow === undefined ? at : Math.min(serverNow, at)
    return res
  }
  const client = createClient(session.apiBase, session.token, fetchImpl)
  const me = session.user.id
  const features = session.meta.features
  const canSince = features.includes('tickets.updated_since')
  const canReply = features.includes('tickets.last_customer_reply_at')
  const openOnly = features.includes('tickets.open_filter')
  const mineQuery: TicketQuery = {
    assigned_to: me as TicketQuery['assigned_to'],
    ...(openOnly ? { open: true } : {}),
  }
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
        ? listMine(client, mineQuery, openOnly ? MAX_PAGES_OPEN : MAX_PAGES_FALLBACK)
        : client
            .listTickets({ ...mineQuery, updated_since: since, per_page: 100 })
            .then((r): Listing => ({ tickets: r.data, complete: false })),
      full
        ? Promise.resolve([] as TicketListItem[])
        : client.listTickets({ unassigned: true, updated_since: since, per_page: 100 }).then((r) => r.data),
    ])
    if (!(await stillCurrent(session))) return

    const snapshot = readSnapshot(st[KEYS.snapshot])
    const notified = pruneNotified((st[KEYS.notified] as Notified | undefined) ?? {}, now)
    const baseline = since === undefined
    const sinceMs = since === undefined ? NaN : Date.parse(since)
    const seen = now.getTime()

    // Only a complete listing proves a ticket is no longer mine. A capped one leaves older
    // entries alone, so a later update on one of them is not mistaken for a new assignment.
    if (full && mine.complete) {
      const mineRefs = new Set(mine.tickets.map((t) => t.reference))
      for (const [ref, entry] of Object.entries(snapshot)) {
        if (sameId(entry.owner, me) && !mineRefs.has(ref)) delete snapshot[ref]
      }
    }

    const alerts: { kind: 'assigned' | 'reply'; ticket: TicketListItem; key: string }[] = []
    for (const t of mine.tickets) {
      if (!sameId(t.assignee?.id, me)) continue
      const wasMine = sameId(snapshot[t.reference]?.owner, me) || expected.has(t.reference)
      snapshot[t.reference] = { owner: String(me), seen }
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
    for (const t of free) if (t.reference in snapshot) snapshot[t.reference] = { owner: null, seen }

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
      [KEYS.lastPollAt]: new Date((serverNow ?? now.getTime()) - OVERLAP_MS).toISOString(),
      ...(full ? { [KEYS.rebaselineAt]: now.getTime() } : {}),
    })
    await chrome.storage.local.remove([KEYS.backoff, KEYS.forbidden])
  } catch (e) {
    if (!(await stillCurrent(session))) return
    if (e instanceof ApiError && e.status === 401) return handleUnauthorized()
    if (e instanceof ApiError && e.status === 403) {
      // The token works but the helpdesk refuses it (for example, no longer an agent). Say so in
      // the panel instead of backing off silently; keep backing off so the helpdesk is not hammered.
      await chrome.storage.local.set({ [KEYS.forbidden]: true })
      await setBadgeError()
    }
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

/** Accepts the older shape too (owner only), treating those entries as seen long ago. */
function readSnapshot(raw: unknown): Snapshot {
  const out: Snapshot = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [ref, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' || v === null) {
      out[ref] = { owner: v, seen: 0 }
    } else if (typeof v === 'object' && v !== null) {
      const e = v as { owner?: unknown; seen?: unknown }
      out[ref] = {
        owner: typeof e.owner === 'string' ? e.owner : null,
        seen: typeof e.seen === 'number' ? e.seen : 0,
      }
    }
  }
  return out
}

/** Keeps the entries seen most recently. Key order plays no part (numeric keys would sort first). */
export function trimSnapshot(s: Snapshot, max = MAX_SNAPSHOT): Snapshot {
  const entries = Object.entries(s)
  if (entries.length <= max) return s
  entries.sort((a, b) => b[1].seen - a[1].seen)
  return Object.fromEntries(entries.slice(0, max))
}
