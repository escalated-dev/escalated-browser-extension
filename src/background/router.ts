import { ApiError } from '../api/errors'
import { createClient } from '../api/client'
import { getSession } from '../state/storage'
import { isApiCall, type ApiResponse, type WireError } from './messages'
import { handleUnauthorized, poll } from './poller'

type Sender = { id?: string; tab?: unknown }

/** Only this extension's own pages; there are no content scripts, so a tab means a stranger. */
export function isTrustedSender(sender: Sender): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined
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

async function callApi(call: unknown, args: unknown): Promise<ApiResponse> {
  if (!isApiCall(call) || !Array.isArray(args)) {
    return { ok: false, error: { status: 400, message: 'Bad request' } }
  }
  const session = await getSession()
  if (!session) return { ok: false, error: { status: 401, message: 'Not connected' } }
  try {
    const client = createClient(session.apiBase, session.token)
    const fn = client[call] as (...a: unknown[]) => Promise<unknown>
    return { ok: true, data: await fn(...args) }
  } catch (e) {
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
  return undefined
}
