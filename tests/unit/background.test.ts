import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSession, getSession } from '../../src/state/storage'
import { send } from '../../src/background/messages'
import type { Session } from '../../src/api/client'
import { getChromeFake } from '../setup/chrome'

const API = 'https://help.test/support/api/v1'
const TOKEN = 'tok_SECRET_123'
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const session = {
  origin: 'https://help.test',
  apiBase: API,
  token: TOKEN,
  user: { id: 7, name: 'Ada', email: 'a@b.c' },
  meta: { api_version: '1.0', backend: 'x', features: [], connect_url: null, web_url_template: null },
} as unknown as Session

type Listener = (msg: unknown, sender: unknown, respond: (r?: unknown) => void) => boolean | void
function dispatch(
  msg: unknown,
  sender: Record<string, unknown> = {
    id: getChromeFake().runtime.id,
    url: getChromeFake().runtime.getURL('sidepanel.html'),
  },
) {
  return new Promise<{ response?: unknown; answered: boolean }>((resolve) => {
    const respond = (r?: unknown) => resolve({ response: r, answered: true })
    const returned = captured!(msg, sender, respond)
    if (!returned) resolve({ answered: false })
  })
}
let captured: Listener | undefined

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(async () => {
  vi.resetModules()
  fetchMock = vi.fn(async () => json(200, { stats: { my_assigned: 0 } }))
  vi.stubGlobal('fetch', fetchMock)
  const c = getChromeFake()
  const add = c.runtime.onMessage.addListener
  c.runtime.onMessage.addListener = (l) => {
    captured = l as Listener
    add(l)
  }
  await setSession(session)
  await import('../../src/background/index')
  await vi.waitFor(() => expect(c.storage.local.accessLevel).toBe('TRUSTED_CONTEXTS'))
})
afterEach(() => vi.unstubAllGlobals())

describe('service worker start', () => {
  it('restricts storage, recreates the poll alarm and registers listeners', async () => {
    const c = getChromeFake()
    await vi.waitFor(() => expect(c.alarms.map.get('poll')).toMatchObject({ periodInMinutes: 1 }))
    expect(c.runtime.onStartup.listenerCount()).toBe(1)
    expect(c.runtime.onInstalled.listenerCount()).toBe(1)
    expect(c.alarms.onAlarm.listenerCount()).toBe(1)
    expect(c.notifications.onClicked.listenerCount()).toBe(1)
  })

  it('recreates the alarm on onInstalled and onStartup', async () => {
    const c = getChromeFake()
    await c.alarms.clear('poll')
    c.runtime.onInstalled.emit({ reason: 'update' })
    await vi.waitFor(() => expect(c.alarms.map.has('poll')).toBe(true))
    await c.alarms.clear('poll')
    c.runtime.onStartup.emit()
    await vi.waitFor(() => expect(c.alarms.map.has('poll')).toBe(true))
  })

  it('polls on the poll alarm only', async () => {
    const c = getChromeFake()
    c.alarms.onAlarm.emit({ name: 'other' })
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).not.toHaveBeenCalled()
    c.alarms.onAlarm.emit({ name: 'poll' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
})

describe('message router', () => {
  it('returns data for an allowlisted call', async () => {
    fetchMock.mockImplementation(async () => json(200, { stats: { my_assigned: 4 } }))
    const r = await dispatch({ type: 'api', call: 'dashboard', args: [] })
    expect(r.response).toEqual({ ok: true, data: { stats: { my_assigned: 4 } } })
    expect(fetchMock.mock.calls[0]![0]).toBe(`${API}/dashboard`)
  })

  it('refuses calls outside the allowlist without touching the client', async () => {
    for (const call of ['revoke', 'meta', 'constructor', '__proto__', 'toString', 7]) {
      const r = await dispatch({ type: 'api', call, args: [] })
      expect(r.response).toEqual({ ok: false, error: { status: 400, message: 'Bad request' } })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores messages from other extensions, content scripts and web pages', async () => {
    const id = getChromeFake().runtime.id
    const msg = { type: 'api', call: 'dashboard', args: [] }
    const senders: Record<string, unknown>[] = [
      { id: 'someoneelse', url: getChromeFake().runtime.getURL('sidepanel.html') },
      { id, url: 'https://evil.example/page', tab: { id: 1 } },
      { id, url: `https://evil.example/chrome-extension://${id}/` },
      { id },
      { url: getChromeFake().runtime.getURL('sidepanel.html') },
    ]
    for (const sender of senders) expect((await dispatch(msg, sender)).answered).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts the extension own page opened in a tab', async () => {
    const id = getChromeFake().runtime.id
    const r = await dispatch(
      { type: 'api', call: 'dashboard', args: [] },
      { id, url: getChromeFake().runtime.getURL('sidepanel.html'), tab: { id: 9 } },
    )
    expect(r.answered).toBe(true)
  })

  it('returns errors as values and never includes the token', async () => {
    fetchMock.mockImplementation(async () =>
      json(422, { message: `bad ${TOKEN}`, errors: { body: ['Required'] } }),
    )
    const r = await dispatch({ type: 'api', call: 'reply', args: ['ESC-1', '', false] })
    expect(r.response).toEqual({
      ok: false,
      error: { status: 422, message: 'bad [redacted]', errors: { body: ['Required'] } },
    })
    expect(JSON.stringify(r.response)).not.toContain(TOKEN)
  })

  it('maps network failures to status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError(`Failed ${TOKEN}`))
    const r = await dispatch({ type: 'api', call: 'dashboard', args: [] })
    expect(r.response).toEqual({ ok: false, error: { status: 0, message: 'Could not reach the helpdesk' } })
  })

  it('treats a 401 from a panel call like a poll 401', async () => {
    fetchMock.mockImplementation(async () => json(401, { message: 'Unauthenticated' }))
    const r = await dispatch({ type: 'api', call: 'agents', args: [] })
    expect((r.response as { ok: boolean }).ok).toBe(false)
    expect(await getSession()).toBeNull()
    expect(getChromeFake().action.badge.text).toBe('!')
  })

  it('poll-now runs a poll', async () => {
    const r = await dispatch({ type: 'poll-now' })
    expect(r.response).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalled()
  })

  it('send() unwraps data and rethrows errors as ApiError', async () => {
    const c = getChromeFake()
    c.runtime.sendMessage.mockImplementation(async (m) => (await dispatch(m)).response)
    fetchMock.mockImplementation(async () => json(200, { stats: { my_assigned: 2 } }))
    expect((await send('dashboard')).stats.my_assigned).toBe(2)
    fetchMock.mockImplementation(async () => json(404, { message: 'Nope' }))
    await expect(send('getTicket', 'ESC-1')).rejects.toMatchObject({ status: 404, message: 'Nope' })
  })
})

describe('worker state', () => {
  it('poll-now during backoff does not fetch', async () => {
    await getChromeFake().storage.local.set({ 'poll.backoff': { until: Date.now() + 600_000, step: 1 } })
    const r = await dispatch({ type: 'poll-now' })
    expect(r.response).toEqual({ ok: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a new session resets poll state and takes a new silent baseline', async () => {
    const c = getChromeFake()
    await c.storage.local.set({
      'poll.lastPollAt': '2020-01-01T00:00:00.000Z',
      'poll.snapshot': { OLD: '7' },
      needsReconnect: true,
    })
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/dashboard')
        ? json(200, { stats: { my_assigned: 1 } })
        : json(200, { data: [{ reference: 'ESC-1', assignee: { id: 7 }, updated_at: 'x' }], meta: {} }),
    )
    await setSession({ ...session, token: 'tok_NEW' })
    await vi.waitFor(() =>
      expect(c.storage.local.dump()['poll.snapshot']).toEqual({
        'ESC-1': { owner: '7', seen: expect.any(Number) },
      }),
    )
    expect(c.storage.local.dump().needsReconnect).toBeUndefined()
    expect(c.storage.local.dump()['poll.lastPollAt']).not.toBe('2020-01-01T00:00:00.000Z')
    expect(c.notifications.create).not.toHaveBeenCalled()
  })

  it('shows a red "!" at start when a reconnect is pending', async () => {
    const c = getChromeFake()
    await c.storage.local.clear()
    await c.storage.local.set({ needsReconnect: true })
    c.runtime.onStartup.emit()
    await vi.waitFor(() => expect(c.action.badge.text).toBe('!'))
    expect(c.action.badge.color).toBe('#dc2626')
  })
})

const listing = (refs: string[]) =>
  json(200, {
    data: refs.map((reference) => ({ reference, subject: reference, assignee: { id: 7 }, updated_at: 'x' })),
    meta: {},
  })

/** One silent baseline poll, so later polls are incremental. */
async function baseline(): Promise<void> {
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith('/dashboard') ? json(200, { stats: { my_assigned: 0 } }) : listing([]),
  )
  await dispatch({ type: 'poll-now' })
  expect(getChromeFake().storage.local.dump()['poll.lastPollAt']).toBeDefined()
}

describe('self-assignment (E3)', () => {
  it('assign to me records the ticket as mine, so the next poll does not alert', async () => {
    const c = getChromeFake()
    await baseline()
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/assign') && init?.method === 'POST')
        return json(200, { message: 'Assigned.' })
      if (String(url).endsWith('/dashboard')) return json(200, { stats: { my_assigned: 1 } })
      return listing(['ESC-5'])
    })
    const r = await dispatch({ type: 'api', call: 'assign', args: ['ESC-5', 7] })
    expect((r.response as { ok: boolean }).ok).toBe(true)
    expect(c.storage.local.dump()['poll.snapshot']).toMatchObject({ 'ESC-5': { owner: '7' } })
    await dispatch({ type: 'poll-now' })
    expect(c.notifications.create).not.toHaveBeenCalled()
  })

  it('assign to someone else, or a failed assign, records nothing', async () => {
    const c = getChromeFake()
    await baseline()
    fetchMock.mockImplementation(async () => json(200, { message: 'Assigned.' }))
    await dispatch({ type: 'api', call: 'assign', args: ['ESC-5', 8] })
    fetchMock.mockImplementation(async () => json(422, { message: 'No.' }))
    await dispatch({ type: 'api', call: 'assign', args: ['ESC-6', 7] })
    const snap = (c.storage.local.dump()['poll.snapshot'] ?? {}) as Record<string, unknown>
    expect(snap['ESC-5']).toBeUndefined()
    expect(snap['ESC-6']).toBeUndefined()
  })

  it('a created ticket assigned to me is recorded as mine', async () => {
    const c = getChromeFake()
    await baseline()
    fetchMock.mockImplementation(async () =>
      json(201, { data: { reference: 'ESC-77', assignee: { id: 7 } }, message: 'Ticket created.' }),
    )
    await dispatch({ type: 'api', call: 'createTicket', args: [{ subject: 's', description: 'd' }] })
    expect(c.storage.local.dump()['poll.snapshot']).toMatchObject({ 'ESC-77': { owner: '7' } })
  })
})

describe('meta refresh (M10)', () => {
  const fresh = {
    api_version: '1.0',
    backend: 'x',
    features: ['tickets.create'],
    connect_url: 'https://evil.test/connect',
    web_url_template: `https://help.test/t/{reference}`,
  }

  it('refresh-meta updates session.meta (sanitised) without resetting the poll baseline', async () => {
    const c = getChromeFake()
    await baseline()
    await c.storage.local.set({ 'poll.snapshot': { KEEP: { owner: '7', seen: 1 } } })
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/meta') ? json(200, fresh) : json(200, { stats: { my_assigned: 0 } }),
    )
    const r = await dispatch({ type: 'refresh-meta' })
    expect(r.response).toEqual({ ok: true })
    const s = await getSession()
    expect(s?.meta.features).toEqual(['tickets.create'])
    expect(s?.meta.connect_url).toBeNull()
    expect(s?.meta.web_url_template).toBe('https://help.test/t/{reference}')
    expect(s?.token).toBe(TOKEN)
    await vi.waitFor(() => expect(c.contextMenus.map.has('create-ticket')).toBe(true))
    expect(c.storage.local.dump()['poll.snapshot']).toEqual({ KEEP: { owner: '7', seen: 1 } })
  })

  it('keeps the stored meta when /meta fails', async () => {
    fetchMock.mockImplementation(async () => json(500, {}))
    await dispatch({ type: 'refresh-meta' })
    expect((await getSession())?.meta.features).toEqual([])
  })

  it('re-reads /meta on browser start', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/meta') ? json(200, fresh) : json(200, { stats: { my_assigned: 0 } }),
    )
    getChromeFake().runtime.onStartup.emit()
    await vi.waitFor(async () => expect((await getSession())?.meta.features).toEqual(['tickets.create']))
  })
})

describe('storage access level (E2)', () => {
  it('the worker still starts its alarm when setAccessLevel is unsupported', async () => {
    const c = getChromeFake()
    c.storage.local.setAccessLevel.mockRejectedValue(new Error('This StorageArea is not supported.'))
    await c.alarms.clear('poll')
    c.runtime.onStartup.emit()
    await vi.waitFor(() => expect(c.alarms.map.has('poll')).toBe(true))
  })
})
