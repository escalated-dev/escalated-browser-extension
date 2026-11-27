import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMine, poll, KEYS, recordMine, trimSnapshot } from '../../src/background/poller'
import { onNotificationClicked, setFocusedWindowId, trackFocusedWindow } from '../../src/background/notify'
import { getSession, setSession } from '../../src/state/storage'
import type { Session } from '../../src/api/client'
import { getChromeFake } from '../setup/chrome'

const API = 'https://help.test/support/api/v1'
const TOKEN = 'tok_SECRET_123'
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const session: Session = {
  origin: 'https://help.test',
  apiBase: API,
  token: TOKEN,
  user: { id: 7, name: 'Ada', email: 'ada@help.test' },
  meta: {
    api_version: '1.0',
    backend: 'laravel',
    features: ['tickets.updated_since', 'tickets.last_customer_reply_at'],
    connect_url: null,
    web_url_template: null,
  } as unknown as Session['meta'],
}

const dash = (my: number) => ({
  stats: { open: 0, my_assigned: my, unassigned: 0, sla_breached: 0, resolved_today: 0 },
})
const ticket = (reference: string, over: Record<string, unknown> = {}) => ({
  id: 1,
  reference,
  subject: `Subject ${reference}`,
  assignee: { id: 7, name: 'Ada' },
  last_customer_reply_at: null,
  updated_at: '2026-11-26T10:00:00Z',
  ...over,
})
const page = (data: unknown[]) => ({ data, meta: {} })

type State = {
  dashboard: () => Response
  mine: (u: URL) => Response
  free: () => Response
}
let state: State
let fetchMock: ReturnType<typeof vi.fn>
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]))

beforeEach(async () => {
  state = {
    dashboard: () => json(200, dash(0)),
    mine: () => json(200, page([])),
    free: () => json(200, page([])),
  }
  fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url)
    if (u.pathname.endsWith('/dashboard')) return state.dashboard()
    if (u.searchParams.get('unassigned')) return state.free()
    return state.mine(u)
  })
  vi.stubGlobal('fetch', fetchMock)
  setFocusedWindowId(undefined)
  await setSession(session)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const T0 = new Date('2026-11-26T10:00:00Z')
const at = (min: number) => new Date(T0.getTime() + min * 60_000)
const local = () => getChromeFake().storage.local.dump()
const notes = () => [...getChromeFake().notifications.map.values()] as { message: string }[]
type Entry = { owner: string | null; seen: number }
const owners = () =>
  Object.fromEntries(
    Object.entries((local()[KEYS.snapshot] ?? {}) as Record<string, Entry>).map(([k, v]) => [k, v.owner]),
  )

describe('badge', () => {
  it.each([
    [0, ''],
    [7, '7'],
    [99, '99'],
    [120, '99+'],
  ])('shows %i as "%s"', async (n, text) => {
    state.dashboard = () => json(200, dash(n))
    await poll(T0)
    expect(getChromeFake().action.badge.text).toBe(text)
  })
})

describe('baseline and notifications', () => {
  it('notifies nothing on the first poll and records a baseline', async () => {
    state.mine = () => json(200, page([ticket('ESC-1')]))
    await poll(T0)
    expect(notes()).toEqual([])
    expect(owners()).toEqual({ 'ESC-1': '7' })
    expect(local()[KEYS.lastPollAt]).toBe('2026-11-26T09:59:55.000Z')
    expect(urls().some((u) => u.includes('updated_since'))).toBe(false)
  })

  it('queries with the contract field names after the baseline', async () => {
    await poll(T0)
    fetchMock.mockClear()
    await poll(at(1))
    const list = urls().filter((u) => u.includes('/tickets'))
    expect(list).toHaveLength(2)
    expect(
      list.some(
        (u) =>
          u.includes('assigned_to=7') &&
          u.includes('updated_since=2026-11-26T09%3A59%3A55.000Z') &&
          u.includes('per_page=100'),
      ),
    ).toBe(true)
    expect(list.some((u) => u.includes('unassigned=1') && u.includes('per_page=100'))).toBe(true)
  })

  it('notifies a newly assigned ticket once even when polled twice', async () => {
    await poll(T0)
    state.mine = () => json(200, page([ticket('ESC-2', { updated_at: '2026-11-26T10:00:30Z' })]))
    await poll(at(1))
    await poll(at(2))
    expect(notes().map((n) => n.message)).toEqual(['Assigned to you: #ESC-2 Subject ESC-2'])
    expect(getChromeFake().notifications.create).toHaveBeenCalledTimes(1)
    expect(getChromeFake().notifications.create.mock.calls[0]![0]).toBe('ESC-2|1')
  })

  it('does not notify a ticket that was already mine', async () => {
    state.mine = () => json(200, page([ticket('ESC-1')]))
    await poll(T0)
    await poll(at(1))
    expect(notes()).toEqual([])
  })

  it('notifies a customer reply on my ticket', async () => {
    state.mine = () => json(200, page([ticket('ESC-1')]))
    await poll(T0)
    state.mine = () =>
      json(
        200,
        page([
          ticket('ESC-1', {
            last_customer_reply_at: '2026-11-26T10:00:30Z',
            updated_at: '2026-11-26T10:00:30Z',
          }),
        ]),
      )
    await poll(at(1))
    await poll(at(2))
    expect(notes().map((n) => n.message)).toEqual(['Customer replied: #ESC-1 Subject ESC-1'])
  })

  it('ignores a customer reply on a ticket assigned to someone else', async () => {
    await poll(T0)
    state.mine = () =>
      json(
        200,
        page([
          ticket('ESC-9', {
            assignee: { id: 8, name: 'Bo' },
            last_customer_reply_at: '2026-11-26T10:00:30Z',
          }),
        ]),
      )
    await poll(at(1))
    expect(notes()).toEqual([])
  })

  it('survives a worker restart: state is read from storage.local, not module memory', async () => {
    await poll(T0)
    state.mine = () => json(200, page([ticket('ESC-2')]))
    await poll(at(1))
    expect(Object.keys(local())).toEqual(
      expect.arrayContaining([KEYS.lastPollAt, KEYS.snapshot, KEYS.notified]),
    )
    expect(Object.keys(local()[KEYS.notified] as object)).toEqual(['ESC-2|2026-11-26T10:00:00Z|assigned'])
    vi.resetModules()
    const fresh = await import('../../src/background/poller')
    await fresh.poll(at(2))
    expect(getChromeFake().notifications.create).toHaveBeenCalledTimes(1)
  })

  it('keys reply alerts on last_customer_reply_at, so one reply alerts once', async () => {
    state.mine = () => json(200, page([ticket('ESC-1')]))
    await poll(T0)
    const reply = (updated: string) =>
      json(
        200,
        page([ticket('ESC-1', { last_customer_reply_at: '2026-11-26T10:00:30Z', updated_at: updated })]),
      )
    state.mine = () => reply('2026-11-26T10:00:30Z')
    await poll(at(1))
    state.mine = () => reply('2026-11-26T10:00:33Z')
    await poll(new Date(at(1).getTime() + 2000))
    expect(getChromeFake().notifications.create).toHaveBeenCalledTimes(1)
  })

  it('keeps polling when a notification fails', async () => {
    await poll(T0)
    getChromeFake().notifications.create.mockRejectedValueOnce(new Error('no permission'))
    state.mine = () => json(200, page([ticket('ESC-2')]))
    await poll(at(1))
    expect(local()[KEYS.backoff]).toBeUndefined()
    expect(local()[KEYS.lastPollAt]).toBe(new Date(at(1).getTime() - 5000).toISOString())
  })

  it('does not run two polls at once: overlapping calls share one set of fetches and one alert', async () => {
    await poll(T0)
    state.mine = () => json(200, page([ticket('ESC-2')]))
    fetchMock.mockClear()
    await Promise.all([poll(at(1)), poll(at(1))])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(getChromeFake().notifications.create).toHaveBeenCalledTimes(1)
  })

  it('records an unassigned ticket only when it was known, and ignores unknown ones', async () => {
    state.mine = () => json(200, page([ticket('ESC-1')]))
    await poll(T0)
    state.free = () =>
      json(200, page([ticket('ESC-1', { assignee: null }), ticket('ESC-8', { assignee: null })]))
    await poll(at(1))
    expect(owners()).toEqual({ 'ESC-1': null })
  })

  it('pages through the whole assigned listing on the baseline', async () => {
    state.mine = (u) =>
      u.searchParams.get('page') === '2'
        ? json(200, { data: [ticket('ESC-3')], meta: { current_page: 2, last_page: 2 } })
        : json(200, { data: [ticket('ESC-1')], meta: { current_page: 1, last_page: 2 } })
    await poll(T0)
    expect(owners()).toEqual({ 'ESC-1': '7', 'ESC-3': '7' })
  })

  it('rebuilds the snapshot hourly so a ticket that left and came back alerts again', async () => {
    state.mine = () => json(200, page([ticket('ESC-1')]))
    await poll(T0)
    // Reassigned away: neither incremental query returns it.
    state.mine = () => json(200, page([]))
    await poll(at(30))
    expect(owners()).toEqual({ 'ESC-1': '7' })
    await poll(at(61))
    expect(owners()).toEqual({})
    // And back to me.
    state.mine = () => json(200, page([ticket('ESC-1', { updated_at: '2026-11-26T11:30:00Z' })]))
    await poll(at(62))
    expect(notes().map((n) => n.message)).toEqual(['Assigned to you: #ESC-1 Subject ESC-1'])
  })

  it('omits updated_since and the unassigned query without the feature, relying on the snapshot', async () => {
    await setSession({ ...session, meta: { ...session.meta, features: ['tickets.last_customer_reply_at'] } })
    await poll(T0)
    state.mine = () => json(200, page([ticket('ESC-2')]))
    fetchMock.mockClear()
    await poll(at(1))
    expect(urls().some((u) => u.includes('updated_since') || u.includes('unassigned'))).toBe(false)
    expect(notes().map((n) => n.message)).toEqual(['Assigned to you: #ESC-2 Subject ESC-2'])
  })

  it('skips reply detection without the last_customer_reply_at feature', async () => {
    await setSession({ ...session, meta: { ...session.meta, features: ['tickets.updated_since'] } })
    state.mine = () => json(200, page([ticket('ESC-1')]))
    await poll(T0)
    state.mine = () => json(200, page([ticket('ESC-1', { last_customer_reply_at: '2026-11-26T10:00:30Z' })]))
    await poll(at(1))
    expect(notes()).toEqual([])
  })

  it('drops dedupe entries older than 24 hours', async () => {
    await poll(T0)
    state.mine = () => json(200, page([ticket('ESC-2')]))
    await poll(at(1))
    state.mine = () => json(200, page([]))
    await poll(at(25 * 60))
    expect(local()[KEYS.notified]).toEqual({})
  })
})

describe('open filter and listing size (E4)', () => {
  const withFeatures = (features: string[]) =>
    setSession({ ...session, meta: { ...session.meta, features } as Session['meta'] })

  it('asks only for open tickets in both "mine" listings when the helpdesk supports it', async () => {
    await withFeatures(['tickets.updated_since', 'tickets.last_customer_reply_at', 'tickets.open_filter'])
    await poll(T0)
    const baseline = urls().filter((u) => u.includes('assigned_to=7'))
    expect(baseline).toHaveLength(1)
    expect(baseline[0]).toContain('open=1')
    expect(baseline[0]).toContain('sort_by=updated_at')
    fetchMock.mockClear()
    await poll(at(1))
    const mine = urls().filter((u) => u.includes('assigned_to=7'))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toContain('open=1')
    expect(mine[0]).toContain('updated_since=')
    // The unassigned query catches tickets leaving me, whatever their status.
    expect(urls().find((u) => u.includes('unassigned=1'))).not.toContain('open=1')
  })

  it('without the feature, sends no open filter and caps the full listing at 5 pages', async () => {
    let n = 0
    state.mine = (u) => {
      n++
      const p = Number(u.searchParams.get('page'))
      return json(200, { data: [ticket(`ESC-${p}`)], meta: { current_page: p, last_page: 50 } })
    }
    await poll(T0)
    expect(n).toBe(5)
    expect(urls().some((u) => u.includes('open='))).toBe(false)
  })

  it('a capped listing does not drop older tickets from the snapshot', async () => {
    await getChromeFake().storage.local.set({ [KEYS.snapshot]: { 'ESC-OLD': { owner: '7', seen: 1 } } })
    state.mine = (u) => {
      const p = Number(u.searchParams.get('page'))
      return json(200, { data: [ticket(`ESC-${p}`)], meta: { current_page: p, last_page: 9 } })
    }
    await poll(T0)
    expect(owners()['ESC-OLD']).toBe('7')
  })

  it('trims by when an entry was last seen, not by key order', () => {
    // Integer-like keys always enumerate first, in numeric order.
    const s = {
      '900': { owner: '7', seen: 1 },
      '10': { owner: '7', seen: 300 },
      'ESC-1': { owner: null, seen: 200 },
      '5': { owner: '7', seen: 100 },
    }
    expect(Object.keys(trimSnapshot(s, 2)).sort()).toEqual(['10', 'ESC-1'])
    expect(trimSnapshot(s, 10)).toBe(s)
  })

  it('reads a snapshot stored in the older owner-only shape', async () => {
    await getChromeFake().storage.local.set({
      [KEYS.lastPollAt]: '2026-11-26T09:59:00.000Z',
      [KEYS.rebaselineAt]: T0.getTime(),
      [KEYS.snapshot]: { 'ESC-1': '7' },
    })
    state.mine = () => json(200, page([ticket('ESC-1')]))
    await poll(at(1))
    expect(notes()).toEqual([])
    expect(local()[KEYS.snapshot]).toEqual({ 'ESC-1': { owner: '7', seen: at(1).getTime() } })
  })
})

describe('server clock (E5)', () => {
  const HTTP_DATE = 'Thu, 26 Nov 2026 10:00:00 GMT'

  it('bases updated_since on the list response Date header, not a skewed client clock', async () => {
    state.mine = () => json(200, page([]), { Date: HTTP_DATE })
    // The client clock runs an hour ahead of the helpdesk.
    await poll(at(60))
    expect(local()[KEYS.lastPollAt]).toBe('2026-11-26T09:59:55.000Z')
    fetchMock.mockClear()
    await poll(at(61))
    expect(urls().find((u) => u.includes('assigned_to=7'))).toContain(
      `updated_since=${encodeURIComponent('2026-11-26T09:59:55.000Z')}`,
    )
  })

  it('uses the earliest Date of the list calls', async () => {
    await poll(T0)
    state.mine = () => json(200, page([]), { Date: 'Thu, 26 Nov 2026 10:01:07 GMT' })
    state.free = () => json(200, page([]), { Date: 'Thu, 26 Nov 2026 10:01:05 GMT' })
    await poll(at(1))
    expect(local()[KEYS.lastPollAt]).toBe('2026-11-26T10:01:00.000Z')
  })

  it('falls back to the client clock when the header is missing or unparseable', async () => {
    state.mine = () => json(200, page([]), { Date: 'not a date' })
    await poll(T0)
    expect(local()[KEYS.lastPollAt]).toBe('2026-11-26T09:59:55.000Z')
  })

  it('ignores the Date of the dashboard call', async () => {
    state.dashboard = () => json(200, dash(0), { Date: 'Thu, 26 Nov 2026 08:00:00 GMT' })
    await poll(T0)
    expect(local()[KEYS.lastPollAt]).toBe('2026-11-26T09:59:55.000Z')
  })
})

describe('own actions do not alert (E3)', () => {
  it('a ticket recorded as mine is not announced as assigned', async () => {
    await poll(T0)
    await recordMine('ESC-2', at(0.5))
    expect(owners()).toEqual({ 'ESC-2': '7' })
    state.mine = () => json(200, page([ticket('ESC-2', { updated_at: '2026-11-26T10:00:40Z' })]))
    await poll(at(1))
    expect(notes()).toEqual([])
  })

  it('a poll already in flight stays quiet about a ticket being self-assigned', async () => {
    await poll(T0)
    expectMine('ESC-3')
    state.mine = () => json(200, page([ticket('ESC-3', { updated_at: '2026-11-26T10:00:40Z' })]))
    await poll(at(1))
    expect(notes()).toEqual([])
    await recordMine('ESC-3')
    expect(owners()['ESC-3']).toBe('7')
  })
})

describe('403 (M14)', () => {
  it('flags the refusal for the panel, shows "!" and still backs off; a later success clears it', async () => {
    state.dashboard = () => json(403, { message: 'This action is unauthorized.' })
    await poll(T0)
    expect(local()[KEYS.forbidden]).toBe(true)
    expect(getChromeFake().action.badge.text).toBe('!')
    expect((local()[KEYS.backoff] as { until: number }).until).toBe(T0.getTime() + 60_000)
    expect(await getSession()).not.toBeNull()
    state.dashboard = () => json(200, dash(2))
    await poll(at(1))
    expect(local()[KEYS.forbidden]).toBeUndefined()
    expect(getChromeFake().action.badge.text).toBe('2')
  })
})

describe('401', () => {
  it('clears the session and alarm, shows a red "!" and remembers to reconnect', async () => {
    await getChromeFake().alarms.create('poll', { periodInMinutes: 1 })
    state.dashboard = () => json(401, { message: 'Unauthenticated' })
    await poll(T0)
    expect(await getSession()).toBeNull()
    expect(getChromeFake().alarms.map.has('poll')).toBe(false)
    expect(getChromeFake().action.badge.text).toBe('!')
    expect(getChromeFake().action.badge.color).toBe('#dc2626')
    expect(local()[KEYS.needsReconnect]).toBe(true)
    expect(urls().some((u) => u.includes('/auth/revoke'))).toBe(false)
  })
})

describe('429 and backoff', () => {
  it('skips polls until Retry-After has passed', async () => {
    state.dashboard = () => json(429, { message: 'Slow down' }, { 'Retry-After': '120' })
    await poll(T0)
    state.dashboard = () => json(200, dash(3))
    fetchMock.mockClear()
    await poll(at(1))
    expect(fetchMock).not.toHaveBeenCalled()
    await poll(new Date(T0.getTime() + 120_000))
    expect(fetchMock).toHaveBeenCalled()
    expect(getChromeFake().action.badge.text).toBe('3')
  })

  it('waits 60 seconds on a 429 without Retry-After', async () => {
    state.dashboard = () => json(429, { message: 'Slow down' })
    await poll(T0)
    expect((local()[KEYS.backoff] as { until: number }).until).toBe(T0.getTime() + 60_000)
  })

  it('backs off 1, 2, 5, 10, 10 minutes on network errors and resets on success', async () => {
    let fail = true
    fetchMock.mockImplementation(async (url: string) => {
      if (fail) throw new TypeError('Failed to fetch')
      return String(url).endsWith('/dashboard') ? json(200, dash(0)) : json(200, page([]))
    })
    let t = T0.getTime()
    for (const minutes of [1, 2, 5, 10, 10]) {
      await poll(new Date(t))
      const b = local()[KEYS.backoff] as { until: number }
      expect(b.until - t).toBe(minutes * 60_000)
      // Just before the window ends: skipped.
      fetchMock.mockClear()
      await poll(new Date(b.until - 1))
      expect(fetchMock).not.toHaveBeenCalled()
      t = b.until
    }
    fail = false
    await poll(new Date(t))
    expect(local()[KEYS.backoff]).toBeUndefined()
    expect(local()[KEYS.lastPollAt]).toBeDefined()
  })

  it('treats a 500 like a network error', async () => {
    state.dashboard = () => json(500, { message: 'boom' })
    await poll(T0)
    expect((local()[KEYS.backoff] as { until: number }).until).toBe(T0.getTime() + 60_000)
  })
})

describe('notification click', () => {
  beforeEach(() => {
    setFocusedWindowId(undefined)
    trackFocusedWindow()
  })

  it('opens the side panel synchronously for the focused window, then sends open-ticket', async () => {
    const c = getChromeFake()
    c.windows.onFocusChanged.emit(42)
    const done = onNotificationClicked('ESC-5')
    // Called before any await: the click's user gesture is still alive.
    expect(c.sidePanel.open).toHaveBeenCalledWith({ windowId: 42 })
    await done
    expect(c.runtime.sendMessage).toHaveBeenCalledWith({ type: 'open-ticket', reference: 'ESC-5' })
    expect(c.storage.session.dump().pendingOpen).toBeUndefined()
  })

  it('ignores WINDOW_ID_NONE focus changes', async () => {
    const c = getChromeFake()
    c.windows.onFocusChanged.emit(42)
    c.windows.onFocusChanged.emit(-1)
    const done = onNotificationClicked('ESC-5')
    expect(c.sidePanel.open).toHaveBeenCalledWith({ windowId: 42 })
    await done
  })

  it('falls back to getLastFocused when no window id is known yet', async () => {
    const c = getChromeFake()
    setFocusedWindowId(undefined)
    c.windows.lastFocusedId = 9
    await onNotificationClicked('ESC-5')
    expect(c.sidePanel.open).toHaveBeenCalledWith({ windowId: 9 })
  })

  it('a cold-start click (no focus history) opens synchronously with the window id in the notification id', async () => {
    const c = getChromeFake()
    setFocusedWindowId(undefined)
    const done = onNotificationClicked('ESC-5|33')
    expect(c.sidePanel.open).toHaveBeenCalledWith({ windowId: 33 })
    expect(c.windows.getLastFocused).toHaveBeenCalledTimes(1) // only trackFocusedWindow's, in beforeEach
    await done
    expect(c.notifications.clear).toHaveBeenCalledWith('ESC-5|33')
    expect(c.runtime.sendMessage).toHaveBeenCalledWith({ type: 'open-ticket', reference: 'ESC-5' })
  })

  it('creates notifications with the window that was focused at the time', async () => {
    const c = getChromeFake()
    c.windows.onFocusChanged.emit(42)
    await poll(T0)
    state.mine = () => json(200, page([ticket('ESC-6')]))
    await poll(at(1))
    expect(c.notifications.create.mock.calls[0]![0]).toBe('ESC-6|42')
  })

  it('parses ids without a window id, and references that contain the separator', async () => {
    const c = getChromeFake()
    c.windows.onFocusChanged.emit(5)
    await onNotificationClicked('ESC-7')
    expect(c.runtime.sendMessage).toHaveBeenLastCalledWith({ type: 'open-ticket', reference: 'ESC-7' })
    await onNotificationClicked('A|B|12')
    expect(c.runtime.sendMessage).toHaveBeenLastCalledWith({ type: 'open-ticket', reference: 'A|B' })
  })

  it('stores pendingOpen when no panel is listening', async () => {
    const c = getChromeFake()
    c.runtime.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'))
    await onNotificationClicked('ESC-5')
    expect(c.storage.session.dump().pendingOpen).toMatchObject({ reference: 'ESC-5' })
  })
})
