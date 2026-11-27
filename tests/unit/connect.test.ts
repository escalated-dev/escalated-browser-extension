import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, disconnect } from '../../src/auth/connect'
import { getSession, setSession } from '../../src/state/storage'
import { sanitiseMeta } from '../../src/api/client'
import { getChromeFake } from '../setup/chrome'

const TOKEN = 'tok_SECRET_123'
const API = 'https://help.test/support/api/v1'
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const metaBody = (over: Record<string, unknown> = {}) => ({
  api_version: '1.0',
  backend: 'laravel',
  features: ['auth.exchange', 'auth.revoke'],
  connect_url: 'https://help.test/support/agent/connect-extension',
  web_url_template: null,
  ...over,
})
const agent = { id: 7, name: 'Ada', email: 'ada@help.test' }
const validateBody = {
  user: agent,
  abilities: [],
  is_agent: true,
  is_admin: false,
  token_name: null,
  expires_at: null,
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
function fetchStub(over: Record<string, Handler> = {}) {
  const routes: Record<string, Handler> = {
    [`GET ${API}/meta`]: () => json(200, metaBody()),
    [`POST ${API}/auth/exchange`]: () =>
      json(200, { token: TOKEN, token_type: 'Bearer', expires_at: null, user: agent }),
    [`POST ${API}/auth/validate`]: () => json(200, validateBody),
    [`POST ${API}/auth/revoke`]: () => new Response(null, { status: 204 }),
    ...over,
  }
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const h = routes[`${init?.method ?? 'GET'} ${url}`]
    return h ? h(url, init) : json(404, {})
  })
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>
}
const fetchedUrls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => c[0] as string)

/** Echo the state the extension sent, with a code, like a well-behaved connect page. */
function approve(extra: Record<string, string> = {}) {
  getChromeFake().identity.launchWebAuthFlow.mockImplementation(async ({ url }) => {
    const u = new URL(url)
    const back = new URL(u.searchParams.get('redirect_uri')!)
    back.searchParams.set('code', 'the-code')
    back.searchParams.set('state', u.searchParams.get('state')!)
    for (const [k, v] of Object.entries(extra)) back.searchParams.set(k, v)
    return back.toString()
  })
}

const consoleSpies = () =>
  (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  )
const logged = (spies: ReturnType<typeof consoleSpies>) => JSON.stringify(spies.flatMap((s) => s.mock.calls))

let spies: ReturnType<typeof consoleSpies>
beforeEach(() => {
  spies = consoleSpies()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('connect: web flow', () => {
  it('stores a session and never logs the token', async () => {
    approve()
    const s = await connect('help.test', { fetchImpl: fetchStub() })
    expect(s).toMatchObject({ origin: 'https://help.test', apiBase: API, token: TOKEN })
    expect(s.user).toEqual({ id: 7, name: 'Ada', email: 'ada@help.test' })
    expect(await getSession()).toEqual(s)
    expect(logged(spies)).not.toContain(TOKEN)
    const fake = getChromeFake()
    expect(fake.storage.local.accessLevel).toBe('TRUSTED_CONTEXTS')
    expect(fake.storage.local.dump()).toHaveProperty('session')
    expect(fake.permissions.request).toHaveBeenCalledWith({ origins: ['https://help.test/*'] })
  })

  it('builds the sign-in URL and exchanges with the verifier', async () => {
    approve()
    const f = fetchStub()
    await connect('help.test', { fetchImpl: f })
    const fake = getChromeFake()
    const [{ url, interactive }] = fake.identity.launchWebAuthFlow.mock.calls[0]!
    expect(interactive).toBe(true)
    const u = new URL(url)
    expect(`${u.origin}${u.pathname}`).toBe('https://help.test/support/agent/connect-extension')
    expect(u.searchParams.get('redirect_uri')).toBe(fake.identity.redirectUrl)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('client_name')).toBe('Chrome')
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>
    const ex = calls.find(([x]) => x.endsWith('/auth/exchange'))!
    const body = JSON.parse(ex[1].body as string)
    expect(body).toMatchObject({ code: 'the-code', redirect_uri: fake.identity.redirectUrl })
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/)
  })

  it('rejects permission_denied without calling the network', async () => {
    getChromeFake().permissions.nextRequest = false
    const f = fetchStub()
    await expect(connect('help.test', { fetchImpl: f })).rejects.toMatchObject({ code: 'permission_denied' })
    expect(f).not.toHaveBeenCalled()
  })

  it('rejects invalid_address before asking for permission', async () => {
    await expect(connect('http://', { fetchImpl: fetchStub() })).rejects.toMatchObject({
      code: 'invalid_address',
    })
    expect(getChromeFake().permissions.request).not.toHaveBeenCalled()
  })

  it('maps discovery failures and releases a permission it just took', async () => {
    const f = fetchStub({ [`GET ${API}/meta`]: () => json(404, {}) })
    await expect(connect('help.test', { fetchImpl: f })).rejects.toMatchObject({ code: 'not_found' })
    expect(getChromeFake().permissions.granted.size).toBe(0)
    const down = vi.fn(async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    await expect(connect('help.test', { fetchImpl: down })).rejects.toMatchObject({ code: 'unreachable' })
  })

  it('rejects denied on access_denied', async () => {
    approve({ error: 'access_denied' })
    await expect(connect('help.test', { fetchImpl: fetchStub() })).rejects.toMatchObject({ code: 'denied' })
  })

  it('rejects connect_failed on any other error, a missing code, or a cancelled window', async () => {
    approve({ error: 'server_error' })
    await expect(connect('help.test', { fetchImpl: fetchStub() })).rejects.toMatchObject({
      code: 'connect_failed',
    })
    getChromeFake().identity.launchWebAuthFlow.mockImplementation(async ({ url }) => {
      const u = new URL(url)
      return `${u.searchParams.get('redirect_uri')}?state=${u.searchParams.get('state')}`
    })
    await expect(connect('help.test', { fetchImpl: fetchStub() })).rejects.toMatchObject({
      code: 'connect_failed',
    })
    getChromeFake().identity.launchWebAuthFlow.mockRejectedValue(
      new Error('The user did not approve access.'),
    )
    await expect(connect('help.test', { fetchImpl: fetchStub() })).rejects.toMatchObject({
      code: 'connect_failed',
    })
  })

  it('rejects state_mismatch without exchanging', async () => {
    getChromeFake().identity.launchWebAuthFlow.mockImplementation(async ({ url }) => {
      const u = new URL(url)
      return `${u.searchParams.get('redirect_uri')}?code=c&state=forged`
    })
    const f = fetchStub()
    await expect(connect('help.test', { fetchImpl: f })).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(fetchedUrls(f).some((u) => u.endsWith('/auth/exchange'))).toBe(false)
  })

  it('rejects a final URL that is not our redirect', async () => {
    getChromeFake().identity.launchWebAuthFlow.mockResolvedValue('https://evil.test/?code=c&state=x')
    await expect(connect('help.test', { fetchImpl: fetchStub() })).rejects.toMatchObject({
      code: 'connect_failed',
    })
  })

  it('rejects connect_failed when exchange fails', async () => {
    approve()
    const f = fetchStub({
      [`POST ${API}/auth/exchange`]: () => json(400, { message: 'Invalid or expired code.' }),
    })
    await expect(connect('help.test', { fetchImpl: f })).rejects.toMatchObject({ code: 'connect_failed' })
    expect(await getSession()).toBeNull()
  })

  it('rejects needs_manual_token without auth.exchange or connect_url', async () => {
    const noFeature = fetchStub({ [`GET ${API}/meta`]: () => json(200, metaBody({ features: [] })) })
    await expect(connect('help.test', { fetchImpl: noFeature })).rejects.toMatchObject({
      code: 'needs_manual_token',
    })
    const noUrl = fetchStub({ [`GET ${API}/meta`]: () => json(200, metaBody({ connect_url: null })) })
    await expect(connect('help.test', { fetchImpl: noUrl })).rejects.toMatchObject({
      code: 'needs_manual_token',
    })
    expect(getChromeFake().identity.launchWebAuthFlow).not.toHaveBeenCalled()
  })
})

describe('connect: manual token', () => {
  it('skips the web flow and stores the session', async () => {
    const f = fetchStub({
      [`GET ${API}/meta`]: () => json(200, metaBody({ features: [], connect_url: null })),
    })
    const s = await connect('help.test', { manualToken: TOKEN, fetchImpl: f })
    expect(s.token).toBe(TOKEN)
    expect(getChromeFake().identity.launchWebAuthFlow).not.toHaveBeenCalled()
    expect(logged(spies)).not.toContain(TOKEN)
  })

  it('maps a 401 to invalid_token, stores nothing and does not log the token', async () => {
    const f = fetchStub({ [`POST ${API}/auth/validate`]: () => json(401, { message: 'Invalid token.' }) })
    await expect(connect('help.test', { manualToken: TOKEN, fetchImpl: f })).rejects.toMatchObject({
      code: 'invalid_token',
    })
    expect(await getSession()).toBeNull()
    expect(getChromeFake().storage.local.dump()).toEqual({})
    expect(logged(spies)).not.toContain(TOKEN)
  })

  it('honours the API path override', async () => {
    const f = fetchStub({
      'GET https://help.test/custom/api/meta': () => json(200, metaBody()),
      'POST https://help.test/custom/api/auth/validate': () => json(200, validateBody),
    })
    const s = await connect('help.test', { apiPath: '/custom/api', manualToken: TOKEN, fetchImpl: f })
    expect(s.apiBase).toBe('https://help.test/custom/api')
  })
})

describe('failure paths never log the token', () => {
  it('exchange network failure', async () => {
    approve()
    const f = fetchStub({
      [`POST ${API}/auth/exchange`]: () => {
        throw new TypeError('boom')
      },
    })
    await expect(connect('help.test', { fetchImpl: f })).rejects.toMatchObject({ code: 'unreachable' })
    expect(logged(spies)).not.toContain(TOKEN)
  })

  it('validate server error after a successful exchange', async () => {
    approve()
    const f = fetchStub({ [`POST ${API}/auth/validate`]: () => json(500, {}) })
    await expect(connect('help.test', { fetchImpl: f })).rejects.toMatchObject({ code: 'connect_failed' })
    expect(await getSession()).toBeNull()
    expect(logged(spies)).not.toContain(TOKEN)
  })
})

describe('disconnect', () => {
  const seed = async () =>
    setSession({
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
      },
    })

  it('revokes, clears storage and removes the origin permission', async () => {
    await seed()
    const fake = getChromeFake()
    fake.permissions.granted.add('https://help.test/*')
    const f = fetchStub()
    await disconnect({ fetchImpl: f })
    expect(f).toHaveBeenCalledWith(`${API}/auth/revoke`, expect.objectContaining({ method: 'POST' }))
    expect(await getSession()).toBeNull()
    expect(fake.permissions.remove).toHaveBeenCalledWith({ origins: ['https://help.test/*'] })
  })

  it('still clears and removes permission when revoke throws', async () => {
    await seed()
    const fake = getChromeFake()
    fake.permissions.granted.add('https://help.test/*')
    const f = fetchStub({
      [`POST ${API}/auth/revoke`]: () => {
        throw new TypeError('offline')
      },
    })
    await disconnect({ fetchImpl: f })
    expect(await getSession()).toBeNull()
    expect(fake.permissions.granted.size).toBe(0)
    expect(logged(spies)).not.toContain(TOKEN)
  })

  it('clears the poll alarm and badge', async () => {
    await seed()
    const fake = getChromeFake()
    await fake.alarms.create('poll', { periodInMinutes: 1 })
    await fake.action.setBadgeText({ text: '3' })
    await disconnect({ fetchImpl: fetchStub() })
    expect(fake.alarms.map.has('poll')).toBe(false)
    expect(fake.action.badge.text).toBe('')
  })

  it('is a no-op without a session', async () => {
    const f = fetchStub()
    await disconnect({ fetchImpl: f })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('hardening', () => {
  it('starts the permission request synchronously', () => {
    const p = connect('help.test', { fetchImpl: fetchStub() })
    expect(getChromeFake().permissions.request).toHaveBeenCalledTimes(1)
    p.catch(() => undefined)
  })

  it('rejects non-http(s) addresses', async () => {
    await expect(connect('ftp://help.test', { fetchImpl: fetchStub() })).rejects.toMatchObject({
      code: 'invalid_address',
    })
    expect(getChromeFake().permissions.request).not.toHaveBeenCalled()
  })

  it('checks state before error', async () => {
    getChromeFake().identity.launchWebAuthFlow.mockImplementation(async ({ url }) => {
      const u = new URL(url)
      return `${u.searchParams.get('redirect_uri')}?error=access_denied&state=forged`
    })
    await expect(connect('help.test', { fetchImpl: fetchStub() })).rejects.toMatchObject({
      code: 'state_mismatch',
    })
  })

  it('rejects a return URL that only shares a prefix with the redirect', async () => {
    getChromeFake().identity.launchWebAuthFlow.mockResolvedValue(
      'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org.evil.test/?code=c&state=x',
    )
    await expect(connect('help.test', { fetchImpl: fetchStub() })).rejects.toMatchObject({
      code: 'connect_failed',
    })
  })

  it('sets the access level before the first write', async () => {
    approve()
    await connect('help.test', { fetchImpl: fetchStub() })
    const l = getChromeFake().storage.local
    expect(l.setAccessLevel.mock.invocationCallOrder[0]!).toBeLessThan(l.set.mock.invocationCallOrder[0]!)
  })

  it('drops a session for a different origin when a new one is stored', async () => {
    const fake = getChromeFake()
    await setSession({
      origin: 'https://old.test',
      apiBase: 'https://old.test/support/api/v1',
      token: 'old_tok',
      user: { id: 1, name: 'O', email: '' },
      meta: {
        api_version: '1.0',
        backend: 'laravel',
        features: [],
        connect_url: null,
        web_url_template: null,
      },
    })
    fake.permissions.granted.add('https://old.test/*')
    approve()
    const f = fetchStub({
      'POST https://old.test/support/api/v1/auth/revoke': () => new Response(null, { status: 204 }),
    })
    await connect('help.test', { fetchImpl: f })
    expect(fake.permissions.granted.has('https://old.test/*')).toBe(false)
    expect(fake.permissions.granted.has('https://help.test/*')).toBe(true)
    expect(fetchedUrls(f)).toContain('https://old.test/support/api/v1/auth/revoke')
    expect((await getSession())?.origin).toBe('https://help.test')
  })

  it('disconnect finishes when revoke hangs', async () => {
    const fake = getChromeFake()
    fake.permissions.granted.add('https://help.test/*')
    await setSession({
      origin: 'https://help.test',
      apiBase: API,
      token: TOKEN,
      user: { id: 7, name: 'Ada', email: '' },
      meta: {
        api_version: '1.0',
        backend: 'laravel',
        features: [],
        connect_url: null,
        web_url_template: null,
      },
    })
    const hung = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch
    await disconnect({ fetchImpl: hung })
    expect(await getSession()).toBeNull()
    expect(fake.permissions.granted.size).toBe(0)
  })

  it('disconnect removes the permission when clearing storage rejects', async () => {
    const fake = getChromeFake()
    fake.permissions.granted.add('https://help.test/*')
    await setSession({
      origin: 'https://help.test',
      apiBase: API,
      token: TOKEN,
      user: { id: 7, name: 'Ada', email: '' },
      meta: {
        api_version: '1.0',
        backend: 'laravel',
        features: [],
        connect_url: null,
        web_url_template: null,
      },
    })
    fake.storage.local.clear.mockRejectedValueOnce(new Error('disk'))
    await expect(disconnect({ fetchImpl: fetchStub() })).rejects.toThrow('disk')
    expect(fake.permissions.granted.size).toBe(0)
  })
})

describe('sanitiseMeta guard', () => {
  it.each([null, undefined, 'x', 5, []])('throws a clear error for %j', (bad) => {
    expect(() => sanitiseMeta(bad as never, API)).toThrow('Invalid meta response')
  })
})
