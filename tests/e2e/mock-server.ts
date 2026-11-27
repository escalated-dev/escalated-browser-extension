import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'

const API = '/support/api/v1'
export const MANUAL_TOKEN = 'e2e-manual-token'
export const REVOKE_DELAY_MS = 300
const REDIRECT = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8')) as T

type Json = Record<string, unknown>
type Reply = Json & { id: number }
type Ticket = Json & { reference: string; replies: Reply[]; assignee: { id: number } | null }

export type Mock = {
  url: string
  /** Every API request, in order, as "METHOD path". */
  requests: string[]
  /** The query of every GET /tickets, in order. */
  listQueries: URLSearchParams[]
  tickets: Ticket[]
  revoked: string[]
  /** When each revoke request arrived (Date.now() on this machine). */
  revokedAt: number[]
  exchanges: number
  /** Test helper: a new ticket assigned to the signed-in agent. */
  addAssignedTicket(subject: string): void
  /** Test helper: the requester replies to a ticket. */
  customerReply(reference: string, body: string): void
  close(): Promise<void>
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  const h = { 'Cache-Control': 'no-store', ...headers }
  if (body === undefined) {
    res.writeHead(status, h).end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...h }).end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json
  } catch {
    return {}
  }
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const LIST_OMIT = [
  'replies',
  'activities',
  'description',
  'channel',
  'metadata',
  'external_reference',
  'tags',
  'sla',
]

const listItem = (t: Ticket): Json => {
  const item = Object.fromEntries(Object.entries(t).filter(([k]) => !LIST_OMIT.includes(k)))
  const requester = t.requester as { name: string; email: string }
  return { ...item, requester: { name: requester.name, email: requester.email } }
}

export async function startMock(): Promise<Mock> {
  const user = fixture<{ id: number; name: string; email: string }>('user.json')
  const tickets = fixture<Ticket[]>('tickets.json')
  const codes = new Map<string, { challenge: string; redirectUri: string }>()
  const valid = new Set<string>([MANUAL_TOKEN])
  let nextReplyId = 1000
  let nextTicketId = 50
  let origin = ''

  const mock: Mock = {
    url: '',
    requests: [],
    listQueries: [],
    tickets,
    revoked: [],
    revokedAt: [],
    exchanges: 0,
    addAssignedTicket(subject) {
      const base = structuredClone(tickets[0]!)
      const id = nextTicketId++
      tickets.push({
        ...base,
        id,
        reference: `ESC-${String(id).padStart(5, '0')}`,
        subject,
        replies: [],
        updated_at: new Date().toISOString(),
      })
    },
    customerReply(reference, body) {
      const t = find(reference)
      if (!t) throw new Error(`No ticket ${reference}`)
      const now = new Date().toISOString()
      const requester = t.requester as { name: string; email: string }
      t.replies.unshift({
        id: nextReplyId++,
        body,
        is_internal_note: false,
        is_pinned: false,
        author: { id: null, name: requester.name, email: requester.email },
        attachments: [],
        created_at: now,
      })
      t.last_customer_reply_at = now
      t.last_reply_at = now
      t.updated_at = now
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }

  const find = (ref: string) => tickets.find((t) => t.reference === ref)

  async function api(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
    const method = req.method ?? 'GET'
    mock.requests.push(`${method} ${path}`)

    if (method === 'GET' && path === '/meta') {
      const meta = fixture<Json>('meta.json')
      const fill = (v: unknown) => (typeof v === 'string' ? v.replace('{origin}', origin) : v)
      return send(res, 200, {
        ...meta,
        connect_url: fill(meta.connect_url),
        web_url_template: fill(meta.web_url_template),
      })
    }
    if (method === 'POST' && path === '/auth/exchange') {
      mock.exchanges++
      const body = await readJson(req)
      const code = typeof body.code === 'string' ? codes.get(body.code) : undefined
      if (typeof body.code === 'string') codes.delete(body.code)
      const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : ''
      const challenge = b64url(createHash('sha256').update(verifier, 'ascii').digest())
      const ok =
        code !== undefined &&
        /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) &&
        challenge === code.challenge &&
        body.redirect_uri === code.redirectUri
      if (!ok) return send(res, 400, { message: 'Invalid or expired code.' })
      const token = `e2e-${b64url(randomBytes(12))}`
      valid.add(token)
      return send(res, 200, { token, token_type: 'Bearer', expires_at: null, user })
    }

    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!auth || !valid.has(auth)) return send(res, 401, { message: 'Invalid token.' })

    if (method === 'POST' && path === '/auth/revoke') {
      valid.delete(auth)
      mock.revoked.push(auth)
      mock.revokedAt.push(Date.now())
      // Answer slowly, so the suite can tell whether the extension waits for the answer.
      await new Promise((done) => setTimeout(done, REVOKE_DELAY_MS))
      return send(res, 204)
    }
    if (method === 'POST' && path === '/auth/validate') {
      return send(res, 200, {
        user,
        abilities: ['agent'],
        is_agent: true,
        is_admin: false,
        token_name: 'Browser extension (Chrome)',
        expires_at: null,
      })
    }
    if (method === 'GET' && path === '/dashboard') {
      const mine = tickets.filter((t) => t.assignee?.id === user.id).length
      return send(res, 200, {
        stats: { open: tickets.length, my_assigned: mine, unassigned: 0, sla_breached: 0, resolved_today: 0 },
        recent_tickets: [],
        needs_attention: { sla_breaching: [], unassigned_urgent: [] },
        my_performance: { resolved_this_week: 0 },
      })
    }
    if (method === 'GET' && path === '/tickets') {
      let rows = [...tickets]
      const q = url.searchParams
      mock.listQueries.push(new URLSearchParams(q))
      if (q.get('assigned_to')) rows = rows.filter((t) => String(t.assignee?.id) === q.get('assigned_to'))
      if (q.get('unassigned')) rows = rows.filter((t) => t.assignee === null)
      if (q.get('status')) rows = rows.filter((t) => t.status === q.get('status'))
      if (q.get('open') === '1') rows = rows.filter((t) => t.status !== 'resolved' && t.status !== 'closed')
      const since = q.get('updated_since')
      if (since !== null) {
        const ms = Date.parse(since)
        if (!Number.isFinite(ms)) {
          return send(res, 422, {
            message: 'The updated since field must be a valid date.',
            errors: { updated_since: ['The updated since field must be a valid date.'] },
          })
        }
        rows = rows.filter((t) => Date.parse(String(t.updated_at)) >= ms)
      }
      const search = q.get('search')?.toLowerCase()
      if (search) rows = rows.filter((t) => String(t.subject).toLowerCase().includes(search))
      const per = Number(q.get('per_page') ?? 15)
      const page = Number(q.get('page') ?? 1)
      return send(res, 200, {
        data: rows.slice((page - 1) * per, page * per).map(listItem),
        meta: {
          current_page: page,
          last_page: Math.max(1, Math.ceil(rows.length / per)),
          per_page: per,
          total: rows.length,
        },
      })
    }
    const lists: Record<string, string> = {
      '/agents': 'agents.json',
      '/departments': 'departments.json',
      '/canned-responses': 'canned-responses.json',
      '/macros': 'macros.json',
    }
    const listFile = lists[path]
    if (method === 'GET' && listFile) return send(res, 200, fixture(listFile))

    const m = /^\/tickets\/([^/]+)(?:\/([a-z]+))?$/.exec(path)
    const ticket = m ? find(decodeURIComponent(m[1]!)) : undefined
    if (m && !ticket) return send(res, 404, { message: 'Ticket not found.' })
    const action = m?.[2]
    if (ticket && method === 'GET' && !action) return send(res, 200, { data: ticket })
    if (ticket && method === 'POST' && action === 'reply') {
      const body = await readJson(req)
      if (typeof body.body !== 'string' || body.body.trim() === '') {
        return send(res, 422, {
          message: 'The body field is required.',
          errors: { body: ['The body field is required.'] },
        })
      }
      const reply: Reply = {
        id: nextReplyId++,
        body: body.body,
        is_internal_note: body.is_internal_note === true,
        is_pinned: false,
        author: { id: user.id, name: user.name, email: user.email },
        attachments: [],
        created_at: new Date().toISOString(),
      }
      ticket.replies.unshift(reply)
      const created = {
        id: reply.id,
        body: reply.body,
        is_internal_note: reply.is_internal_note,
        author: reply.author,
        created_at: reply.created_at,
      }
      return send(res, 201, { data: created, message: 'Reply added.' })
    }
    if (ticket && method === 'PATCH' && (action === 'status' || action === 'priority')) {
      const body = await readJson(req)
      const value = String(body[action])
      ticket[action] = value
      ticket[`${action}_label`] = value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ')
      return send(res, 200, { message: 'Updated.', [action]: value })
    }
    if (ticket && method === 'POST' && action === 'assign') {
      const body = await readJson(req)
      const agent = fixture<{ data: { id: number; name: string; email: string }[] }>('agents.json').data.find(
        (a) => a.id === body.agent_id,
      )
      ticket.assignee = agent ?? null
      return send(res, 200, { message: 'Assigned.' })
    }
    return send(res, 404, { message: 'Not found.' })
  }

  /** The connect page. Test only: it approves at once, which the real page must never do. */
  function connectPage(res: ServerResponse, url: URL) {
    const q = url.searchParams
    const redirect = q.get('redirect_uri') ?? ''
    if (!REDIRECT.test(redirect)) return send(res, 400, { message: 'Invalid redirect_uri.' })
    const challenge = q.get('code_challenge') ?? ''
    const state = q.get('state') ?? ''
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !state) {
      res
        .writeHead(302, { Location: `${redirect}?error=invalid_request&state=${encodeURIComponent(state)}` })
        .end()
      return
    }
    const code = b64url(randomBytes(32))
    codes.set(code, { challenge, redirectUri: redirect })
    res
      .writeHead(302, {
        Location: `${redirect}?code=${code}&state=${encodeURIComponent(state)}`,
        'Cache-Control': 'no-store',
      })
      .end()
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const path = url.pathname
    const handle = async () => {
      if (path === '/support/agent/connect-extension') return connectPage(res, url)
      if (path.startsWith(`${API}/`)) return api(req, res, path.slice(API.length), url)
      send(res, 404, { message: 'Not found.' })
    }
    handle().catch(() => send(res, 500, { message: 'Mock error.' }))
  })

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  mock.url = origin
  return mock
}
