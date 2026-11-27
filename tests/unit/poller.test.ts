import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { poll, KEYS } from '../../src/background/poller'
import { onNotificationClicked } from '../../src/background/notify'
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
    features: [],
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
  mine: () => Response
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
    return state.mine()
  })
  vi.stubGlobal('fetch', fetchMock)
  await setSession(session)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const T0 = new Date('2026-11-26T10:00:00Z')
const at = (min: number) => new Date(T0.getTime() + min * 60_000)
const local = () => getChromeFake().storage.local.dump()
const notes = () => [...getChromeFake().notifications.map.values()] as { message: string }[]

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
    expect(local()[KEYS.snapshot]).toEqual({ 'ESC-1': '7' })
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
    expect(getChromeFake().notifications.create.mock.calls[0]![0]).toBe('ESC-2')
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

  it('keeps no persistent state in memory: snapshot, dedupe and lastPollAt are in storage.local', async () => {
    await poll(T0)
    state.mine = () => json(200, page([ticket('ESC-2')]))
    await poll(at(1))
    expect(Object.keys(local())).toEqual(
      expect.arrayContaining([KEYS.lastPollAt, KEYS.snapshot, KEYS.notified]),
    )
    expect(Object.keys(local()[KEYS.notified] as object)).toEqual(['ESC-2|2026-11-26T10:00:00Z|assigned'])
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
  it('sends open-ticket and opens the side panel for the last focused window', async () => {
    const c = getChromeFake()
    c.windows.lastFocusedId = 42
    await onNotificationClicked('ESC-5')
    expect(c.sidePanel.open).toHaveBeenCalledWith({ windowId: 42 })
    expect(c.runtime.sendMessage).toHaveBeenCalledWith({ type: 'open-ticket', reference: 'ESC-5' })
    expect(c.storage.session.dump().pendingOpen).toBeUndefined()
  })

  it('stores pendingOpen when no panel is listening', async () => {
    const c = getChromeFake()
    c.runtime.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'))
    await onNotificationClicked('ESC-5')
    expect(c.storage.session.dump().pendingOpen).toMatchObject({ reference: 'ESC-5' })
  })
})
