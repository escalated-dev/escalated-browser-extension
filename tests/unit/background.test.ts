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
    await setSession(session)
    await vi.waitFor(() => expect(c.storage.local.dump()['poll.snapshot']).toEqual({ 'ESC-1': '7' }))
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
