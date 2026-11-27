import { ApiError } from '../api/errors'
import { createClient } from '../api/client'
import { getSession } from '../state/storage'
import { isApiCall, type ApiResponse, type WireError } from './messages'
import { refreshMeta } from './meta'
import { expectMine, forgetExpected, handleUnauthorized, poll, recordMine } from './poller'

type Sender = { id?: string; url?: string }

/**
 * Only this extension's own pages (the side panel, or one of its pages opened in a tab).
 * A content script carries this extension's id but the URL of the web page it runs in.
 */
export function isTrustedSender(sender: Sender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(chrome.runtime.getURL(''))
  )
}

function toWire(e: unknown, token: string): WireError {
  const scrub = (s: string) => (token ? s.split(token).join('[redacted]') : s)
  if (e instanceof ApiError) {
    const out: WireError = { status: e.status, message: scrub(e.message) }
    if (e.errors) out.errors = e.errors
    return out
  }
  return { status: 0, message: 'Could not reach the helpdesk' }
}

const sameId = (a: unknown, b: unknown) => a !== undefined && a !== null && String(a) === String(b)

async function callApi(call: unknown, args: unknown): Promise<ApiResponse> {
  if (!isApiCall(call) || !Array.isArray(args)) {
    return { ok: false, error: { status: 400, message: 'Bad request' } }
  }
  const session = await getSession()
  if (!session) return { ok: false, error: { status: 401, message: 'Not connected' } }
  const me = session.user.id
  // Assigning to yourself must not come back a minute later as "Assigned to you".
  const selfAssign = call === 'assign' && typeof args[0] === 'string' && sameId(args[1], me)
  if (selfAssign) expectMine(args[0] as string)
  try {
    const client = createClient(session.apiBase, session.token)
    const fn = client[call] as (...a: unknown[]) => Promise<unknown>
    const data = await fn(...args)
    if (selfAssign) await recordMine(args[0] as string).catch(() => undefined)
    if (call === 'createTicket') {
      const created = (data as { data?: { reference?: unknown; assignee?: { id?: unknown } | null } } | null)
        ?.data
      if (typeof created?.reference === 'string' && sameId(created.assignee?.id, me)) {
        await recordMine(created.reference).catch(() => undefined)
      }
    }
    return { ok: true, data }
  } catch (e) {
    if (selfAssign) forgetExpected(args[0] as string)
    if (e instanceof ApiError && e.status === 401) await handleUnauthorized().catch(() => undefined)
    return { ok: false, error: toWire(e, session.token) }
  }
}

/** Returns a promise for messages it handles, or undefined to let other listeners answer. */
export function handleMessage(msg: unknown, sender: Sender): Promise<ApiResponse | { ok: true }> | undefined {
  if (!isTrustedSender(sender)) return undefined
  if (typeof msg !== 'object' || msg === null) return undefined
  const m = msg as { type?: unknown; call?: unknown; args?: unknown }
  if (m.type === 'api') return callApi(m.call, m.args)
  if (m.type === 'poll-now') {
    return poll().then(
      () => ({ ok: true as const }),
      (): ApiResponse => ({ ok: false, error: { status: 0, message: 'Poll failed' } }),
    )
  }
  if (m.type === 'refresh-meta') {
    return refreshMeta().then(
      () => ({ ok: true as const }),
      () => ({ ok: true as const }),
    )
  }
  return undefined
}
