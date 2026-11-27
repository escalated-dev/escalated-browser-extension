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
function dispatch(msg: unknown, sender: Record<string, unknown> = { id: getChromeFake().runtime.id }) {
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

  it('ignores messages from other extensions and from tabs', async () => {
    const a = await dispatch({ type: 'api', call: 'dashboard', args: [] }, { id: 'someoneelse' })
    expect(a.answered).toBe(false)
    const b = await dispatch(
      { type: 'api', call: 'dashboard', args: [] },
      { id: getChromeFake().runtime.id, tab: { id: 1 } },
    )
    expect(b.answered).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
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
