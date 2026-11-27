import { describe, expect, it, vi } from 'vitest'
import { createClient, discover, normaliseAddress } from '../../src/api/client'
import { ApiError } from '../../src/api/errors'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const stub = (...responses: Array<Response | Error>) => {
  const fn = vi.fn(async () => {
    const r = responses.shift()
    if (r instanceof Error) throw r
    return r ?? json(404, {})
  })
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

const urls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => c[0] as string)
const calls = (f: ReturnType<typeof vi.fn>) => f.mock.calls as unknown as Array<[string, RequestInit]>

describe('client', () => {
  it('sends Bearer and Accept headers', async () => {
    const f = stub(json(200, { data: [] }))
    await createClient('https://h.test/support/api/v1', 'tok', f).agents()
    const [url, init] = calls(f)[0]!
    expect(url).toBe('https://h.test/support/api/v1/agents')
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer tok')
    expect(h.Accept).toBe('application/json')
  })

  it('throws ApiError with status 401', async () => {
    const f = stub(json(401, { message: 'Invalid token.' }))
    const err = await createClient('https://h.test/a', 't', f)
      .validate()
      .catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(err.message).toBe('Invalid token.')
  })

  it('carries retryAfter on 429', async () => {
    const f = stub(json(429, { message: 'Too many requests.' }, { 'Retry-After': '30' }))
    const err = await createClient('https://h.test/a', 't', f)
      .dashboard()
      .catch((e) => e)
    expect(err.status).toBe(429)
    expect(err.retryAfter).toBe(30)
  })

  it('carries errors on 422', async () => {
    const f = stub(json(422, { message: 'bad', errors: { status: ['Nope.'] } }))
    const err = await createClient('https://h.test/a', 't', f)
      .setStatus('ESC-1', 'closed')
      .catch((e) => e)
    expect(err.status).toBe(422)
    expect(err.errors).toEqual({ status: ['Nope.'] })
  })

  it('builds the ticket query', async () => {
    const f = stub(json(200, { data: [], meta: {} }))
    await createClient('https://h.test/a', 't', f).listTickets({
      unassigned: true,
      updated_since: '2026-11-26T10:00:00Z',
    })
    expect(urls(f)[0]).toBe('https://h.test/a/tickets?unassigned=1&updated_since=2026-11-26T10%3A00%3A00Z')
  })

  it('uses the contract request shapes', async () => {
    const f = stub(
      json(201, { data: {}, message: '' }),
      json(200, {}),
      json(200, {}),
      json(200, {}),
      json(201, { data: {}, message: '' }),
      new Response(null, { status: 204 }),
    )
    const c = createClient('https://h.test/a', 't', f)
    await c.reply('ESC-1', 'hi', true)
    await c.setStatus('ESC-1', 'resolved')
    await c.assign('ESC-1', 7)
    await c.applyMacro('ESC-1', 3)
    await c.createTicket({ subject: 's', description: 'd', priority: 'high' })
    await expect(c.revoke()).resolves.toBeUndefined()
    const cs = calls(f)
    expect(cs.map((x) => `${x[1].method} ${x[0]}`)).toEqual([
      'POST https://h.test/a/tickets/ESC-1/reply',
      'PATCH https://h.test/a/tickets/ESC-1/status',
      'POST https://h.test/a/tickets/ESC-1/assign',
      'POST https://h.test/a/tickets/ESC-1/macro',
      'POST https://h.test/a/tickets',
      'POST https://h.test/a/auth/revoke',
    ])
    expect(JSON.parse(cs[0]![1].body as string)).toEqual({ body: 'hi', is_internal_note: true })
    expect(JSON.parse(cs[2]![1].body as string)).toEqual({ agent_id: 7 })
    expect(JSON.parse(cs[3]![1].body as string)).toEqual({ macro_id: 3 })
    expect(JSON.parse(cs[4]![1].body as string)).toEqual({
      subject: 's',
      description: 'd',
      priority: 'high',
    })
  })
})

describe('normaliseAddress', () => {
  it('normalises', () => {
    expect(normaliseAddress('example.com')).toBe('https://example.com')
    expect(normaliseAddress('https://Example.com/support/')).toBe('https://example.com/support')
    expect(normaliseAddress('http://localhost:8000')).toBe('http://localhost:8000')
  })
})

const meta = (extra: Record<string, unknown> = {}) => ({
  api_version: '1.0',
  backend: 'laravel',
  features: ['tickets.create'],
  connect_url: 'https://example.com/support/agent/connect-extension',
  web_url_template: 'https://example.com/support/agent/tickets/{reference}',
  ...extra,
})

describe('discover', () => {
  it('tries the default prefix first and returns on 200', async () => {
    const f = stub(json(200, meta()))
    const r = await discover('Example.com/', f)
    expect(urls(f)).toEqual(['https://example.com/support/api/v1/meta'])
    expect(r).toMatchObject({ apiBase: 'https://example.com/support/api/v1' })
  })

  it('falls through on 404, 401, non-JSON and bad bodies', async () => {
    const f = stub(
      json(404, {}),
      json(401, {}),
      new Response('<html>', { status: 200 }),
      json(200, { api_version: 1 }),
    )
    const r = await discover('example.com', f)
    expect(urls(f)).toEqual([
      'https://example.com/support/api/v1/meta',
      'https://example.com/wp-json/escalated/v1/meta',
      'https://example.com/escalated/api/v1/meta',
      'https://example.com/escalated/api/meta',
    ])
    expect(r).toEqual({ error: 'not_found' })
  })

  it('finds a later prefix', async () => {
    const f = stub(json(404, {}), json(200, meta()))
    const r = await discover('example.com', f)
    expect(r).toMatchObject({ apiBase: 'https://example.com/wp-json/escalated/v1' })
  })

  it('reports unreachable only when every candidate fails on the network', async () => {
    const e = () => new TypeError('Failed to fetch')
    expect(await discover('example.com', stub(e(), e(), e(), e()))).toEqual({
      error: 'unreachable',
    })
    expect(await discover('example.com', stub(e(), json(404, {}), e(), e()))).toEqual({
      error: 'not_found',
    })
  })

  it('treats a redirect as not found and sends redirect: manual', async () => {
    const opaque = new Response(null, { status: 200 })
    Object.defineProperty(opaque, 'type', { value: 'opaqueredirect' })
    const f = stub(opaque, json(302, {}), json(404, {}), json(404, {}))
    expect(await discover('example.com', f)).toEqual({ error: 'not_found' })
    expect(calls(f)[0]![1].redirect).toBe('manual')
  })

  it('drops connect_url and web_url_template on another origin', async () => {
    const f = stub(
      json(
        200,
        meta({
          connect_url: 'https://evil.test/connect',
          web_url_template: 'https://evil.test/{reference}',
        }),
      ),
    )
    const r = await discover('example.com', f)
    expect(r).toMatchObject({ meta: { connect_url: null, web_url_template: null } })
  })

  it('drops only the field that is off origin', async () => {
    const f = stub(json(200, meta({ connect_url: 'http://example.com/connect' })))
    const r = await discover('example.com', f)
    expect(r).toMatchObject({
      meta: {
        connect_url: null,
        web_url_template: 'https://example.com/support/agent/tickets/{reference}',
      },
    })
  })

  it('honours an API path override', async () => {
    const f = stub(json(200, meta()))
    await discover('example.com', f, '/custom/api/')
    expect(urls(f)).toEqual(['https://example.com/custom/api/meta'])
  })
})

describe('fixes', () => {
  it('meta() applies the same-origin rule', async () => {
    const f = stub(
      json(
        200,
        meta({ connect_url: 'https://evil.test/c', web_url_template: 'https://evil.test/{reference}' }),
      ),
    )
    const m = await createClient('https://example.com/support/api/v1', 't', f).meta()
    expect(m.connect_url).toBeNull()
    expect(m.web_url_template).toBeNull()
  })

  it('normaliseAddress handles ports, IPv6, query and fragment', () => {
    expect(normaliseAddress('[::1]:8000')).toBe('https://[::1]:8000')
    expect(normaliseAddress('localhost:8000')).toBe('https://localhost:8000')
    expect(normaliseAddress('https://h.test:8443/')).toBe('https://h.test:8443')
    expect(normaliseAddress('https://h.test/support?x=1#f')).toBe('https://h.test/support')
    expect(normaliseAddress('https://exa mple.com/a/?x=1#f')).toBe('https://exa mple.com/a')
  })

  it('encodes + offsets and omits empty query values', async () => {
    const f = stub(json(200, { data: [], meta: {} }))
    await createClient('https://h.test/a', 't', f).listTickets({
      updated_since: '2026-11-26T10:00:00+00:00',
      search: '',
      status: undefined,
      assigned_to: null as unknown as undefined,
    })
    expect(urls(f)[0]).toBe('https://h.test/a/tickets?updated_since=2026-11-26T10%3A00%3A00%2B00%3A00')
  })

  it('never puts the token in a URL or an error message', async () => {
    const f = stub(json(401, { message: 'Invalid token.' }), json(200, { data: [] }))
    const c = createClient('https://h.test/a', 'SECRET-TOKEN', f)
    const err = await c.validate().catch((e) => e)
    await c.agents()
    expect(err.message).not.toContain('SECRET-TOKEN')
    for (const u of urls(f)) expect(u).not.toContain('SECRET-TOKEN')
  })

  it('reports an unparseable address clearly', async () => {
    const f = stub()
    expect(await discover('https://exa mple.com', f)).toEqual({ error: 'invalid_address' })
    expect(f).not.toHaveBeenCalled()
  })
})
