import type { components, operations } from './schema'
import { ApiError } from './errors'

type Schemas = components['schemas']
type JsonBody<Op, Status extends number> = Op extends {
  responses: Record<Status, { content: { 'application/json': infer B } }>
}
  ? B
  : never
type RequestBody<Op> = Op extends {
  requestBody: { content: { 'application/json': infer B } }
}
  ? B
  : never

/** The contract types `web_url_template` as a string; discovery may null it out. */
export type Meta = Omit<Schemas['Meta'], 'web_url_template'> & {
  web_url_template: string | null
}

export type Session = {
  origin: string
  apiBase: string
  token: string
  user: { id: number | string; name: string; email: string }
  meta: Meta
}

export type TicketStatus = Schemas['TicketStatus']
export type TicketPriority = Schemas['TicketPriority']
export type TicketListItem = Schemas['TicketListItem']
export type Ticket = Schemas['Ticket']
export type Reply = Schemas['Reply']
export type ReplyCreated = Schemas['ReplyCreated']
export type Agent = Schemas['Agent']
export type Department = Schemas['Department']
export type CannedResponse = Schemas['CannedResponse']
export type Macro = Schemas['Macro']
export type Dashboard = Schemas['Dashboard']
export type CreateTicketInput = Schemas['CreateTicketRequest']
export type TicketPage = JsonBody<operations['listTickets'], 200>
export type ValidateResponse = Schemas['AuthValidateResponse']

type ListQuery = NonNullable<operations['listTickets']['parameters']['query']>
export type TicketQuery = {
  status?: ListQuery['status']
  priority?: ListQuery['priority']
  assigned_to?: ListQuery['assigned_to']
  unassigned?: boolean
  /** Any open-family status (all but resolved and closed). Only when meta lists tickets.open_filter. */
  open?: boolean
  search?: string
  sort_by?: 'created_at' | 'updated_at'
  sort_dir?: 'asc' | 'desc'
  updated_since?: string
  page?: number
  per_page?: number
}

export type FetchLike = typeof fetch

type Opts = { query?: Record<string, string>; body?: unknown }

function buildQuery(q: TicketQuery): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    out[k] = v === true ? '1' : String(v)
  }
  return out
}

function parseRetryAfter(res: Response, body: unknown): number | undefined {
  const header = res.headers.get('Retry-After')
  if (header !== null && header.trim() !== '' && Number.isFinite(Number(header))) {
    return Number(header)
  }
  const fromBody = (body as { retry_after?: unknown } | null)?.retry_after
  return typeof fromBody === 'number' ? fromBody : undefined
}

export function createClient(apiBase: string, token: string, fetchImpl: FetchLike = fetch) {
  const base = apiBase.replace(/\/+$/, '')

  async function request<T>(method: string, path: string, opts: Opts = {}): Promise<T> {
    const qs = opts.query ? new URLSearchParams(opts.query).toString() : ''
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
    const init: RequestInit = { method, headers, redirect: 'manual' }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(opts.body)
    }
    const res = await fetchImpl(`${base}${path}${qs ? `?${qs}` : ''}`, init)
    if (res.status === 204) return undefined as T
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = null
    }
    if (!res.ok || res.type === 'opaqueredirect') {
      const b = (body ?? {}) as { message?: unknown; errors?: Record<string, string[]> }
      const extra: { retryAfter?: number; errors?: Record<string, string[]> } = {}
      const retryAfter = res.status === 429 ? parseRetryAfter(res, body) : undefined
      if (retryAfter !== undefined) extra.retryAfter = retryAfter
      if (res.status === 422 && b.errors) extra.errors = b.errors
      throw new ApiError(
        typeof b.message === 'string' ? b.message : `Request failed (${res.status})`,
        res.status,
        extra,
      )
    }
    return body as T
  }

  const ref = (r: string) => `/tickets/${encodeURIComponent(r)}`

  return {
    meta: async () => sanitiseMeta(await request<Schemas['Meta']>('GET', '/meta'), base),
    validate: () => request<ValidateResponse>('POST', '/auth/validate'),
    dashboard: () => request<Dashboard>('GET', '/dashboard'),
    listTickets: (q: TicketQuery = {}) => request<TicketPage>('GET', '/tickets', { query: buildQuery(q) }),
    getTicket: (r: string) => request<JsonBody<operations['getTicket'], 200>>('GET', ref(r)),
    reply: (r: string, body: string, internal: boolean) =>
      request<JsonBody<operations['replyToTicket'], 201>>('POST', `${ref(r)}/reply`, {
        body: { body, is_internal_note: internal },
      }),
    setStatus: (r: string, status: TicketStatus) =>
      request<JsonBody<operations['updateTicketStatus'], 200>>('PATCH', `${ref(r)}/status`, {
        body: { status },
      }),
    setPriority: (r: string, priority: TicketPriority) =>
      request<JsonBody<operations['updateTicketPriority'], 200>>('PATCH', `${ref(r)}/priority`, {
        body: { priority },
      }),
    assign: (r: string, agentId: RequestBody<operations['assignTicket']>['agent_id']) =>
      request<JsonBody<operations['assignTicket'], 200>>('POST', `${ref(r)}/assign`, {
        body: { agent_id: agentId },
      }),
    applyMacro: (r: string, macroId: number) =>
      request<JsonBody<operations['applyMacro'], 200>>('POST', `${ref(r)}/macro`, {
        body: { macro_id: macroId },
      }),
    createTicket: (input: CreateTicketInput) =>
      request<JsonBody<operations['createTicket'], 201>>('POST', '/tickets', { body: input }),
    agents: () => request<JsonBody<operations['listAgents'], 200>>('GET', '/agents'),
    departments: () => request<JsonBody<operations['listDepartments'], 200>>('GET', '/departments'),
    cannedResponses: () =>
      request<JsonBody<operations['listCannedResponses'], 200>>('GET', '/canned-responses'),
    macros: () => request<JsonBody<operations['listMacros'], 200>>('GET', '/macros'),
    revoke: () => request<void>('POST', '/auth/revoke'),
  }
}

export type Client = ReturnType<typeof createClient>

export function normaliseAddress(input: string): string {
  let s = input.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  try {
    const u = new URL(s)
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return s.replace(/[?#].*$/s, '').replace(/\/+$/, '')
  }
}

const PREFIXES = ['/support/api/v1', '/wp-json/escalated/v1', '/escalated/api/v1', '/escalated/api']

function sameOrigin(value: unknown, origin: string): string | null {
  if (typeof value !== 'string') return null
  try {
    return new URL(value).origin === origin ? value : null
  } catch {
    return null
  }
}

/** True for an http:// URL served under an https:// API, typically a proxy that hides https. */
function downgraded(value: unknown, apiBase: string): boolean {
  if (typeof value !== 'string') return false
  try {
    return new URL(apiBase).protocol === 'https:' && new URL(value).protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * sanitiseMeta, and whether connect_url was dropped because it is http:// under an https:// API,
 * so the connect screen can say why sign-in is not offered.
 */
export function inspectMeta(
  raw: Schemas['Meta'],
  apiBase: string,
): { meta: Meta; insecureConnectUrl: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid meta response')
  }
  const origin = new URL(apiBase).origin
  const meta: Meta = {
    ...raw,
    features: Array.isArray(raw.features) ? raw.features : [],
    connect_url: sameOrigin(raw.connect_url, origin),
    web_url_template: sameOrigin(raw.web_url_template, origin),
  }
  return { meta, insecureConnectUrl: meta.connect_url === null && downgraded(raw.connect_url, apiBase) }
}

/** Drops connect_url and web_url_template unless they share the API base's origin. */
export function sanitiseMeta(raw: Schemas['Meta'], apiBase: string): Meta {
  return inspectMeta(raw, apiBase).meta
}

export type DiscoverResult =
  | { apiBase: string; meta: Meta; insecureConnectUrl: boolean }
  | { error: 'not_found' | 'unreachable' | 'invalid_address' }

/** `apiPath` is the Advanced "API path" override; it replaces the candidate list. */
export async function discover(
  address: string,
  fetchImpl: FetchLike = fetch,
  apiPath?: string,
): Promise<DiscoverResult> {
  const root = normaliseAddress(address)
  try {
    new URL(root)
  } catch {
    return { error: 'invalid_address' }
  }
  const prefixes = apiPath?.trim() ? [`/${apiPath.trim().replace(/^\/+|\/+$/g, '')}`] : PREFIXES
  let failures = 0
  for (const prefix of prefixes) {
    const apiBase = `${root}${prefix}`
    try {
      const res = await fetchImpl(`${apiBase}/meta`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      })
      if (res.status !== 200 || res.type === 'opaqueredirect') continue
      let body: unknown
      try {
        body = await res.json()
      } catch {
        continue
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        typeof (body as { api_version?: unknown }).api_version !== 'string'
      ) {
        continue
      }
      return { apiBase, ...inspectMeta(body as Schemas['Meta'], apiBase) }
    } catch {
      failures++
    }
  }
  return { error: failures === prefixes.length ? 'unreachable' : 'not_found' }
}
