import { ApiError } from '../api/errors'
import {
  createClient,
  discover,
  normaliseAddress,
  type FetchLike,
  type Meta,
  type Session,
} from '../api/client'
import { clearSession, getSession, setSession } from '../state/storage'
import { createPkce, randomBase64Url } from './pkce'

export type ConnectErrorCode =
  | 'invalid_address'
  | 'not_found'
  | 'unreachable'
  | 'permission_denied'
  | 'needs_manual_token'
  | 'denied'
  | 'state_mismatch'
  | 'connect_failed'
  | 'invalid_token'

/** `message` is the code, so callers can match either `err.code` or `err.message`. */
export class ConnectError extends Error {
  code: ConnectErrorCode
  constructor(code: ConnectErrorCode) {
    super(code)
    this.name = 'ConnectError'
    this.code = code
  }
}

export type ConnectOptions = { apiPath?: string; manualToken?: string; fetchImpl?: FetchLike }

const originOf = (address: string): string | null => {
  try {
    return new URL(normaliseAddress(address)).origin
  } catch {
    return null
  }
}

/** Opens the helpdesk sign-in page and returns the authorisation code. */
async function webFlow(meta: Meta): Promise<{ code: string; verifier: string; redirectUri: string }> {
  const redirectUri = chrome.identity.getRedirectURL()
  const state = randomBase64Url(32)
  const { verifier, challenge } = await createPkce()
  const url = new URL(meta.connect_url!)
  url.search = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    client_name: 'Chrome',
  }).toString()

  let finalUrl: string | undefined
  try {
    finalUrl = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true })
  } catch {
    throw new ConnectError('connect_failed')
  }
  let back: URL
  try {
    back = new URL(finalUrl ?? '')
  } catch {
    throw new ConnectError('connect_failed')
  }
  if (!back.href.startsWith(redirectUri)) throw new ConnectError('connect_failed')

  const error = back.searchParams.get('error')
  if (error) throw new ConnectError(error === 'access_denied' ? 'denied' : 'connect_failed')
  if (back.searchParams.get('state') !== state) throw new ConnectError('state_mismatch')
  const code = back.searchParams.get('code')
  if (!code) throw new ConnectError('connect_failed')
  return { code, verifier, redirectUri }
}

async function exchange(apiBase: string, flow: Awaited<ReturnType<typeof webFlow>>, f: FetchLike) {
  let res: Response
  try {
    res = await f(`${apiBase}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code: flow.code, code_verifier: flow.verifier, redirect_uri: flow.redirectUri }),
      redirect: 'manual',
    })
  } catch {
    throw new ConnectError('unreachable')
  }
  let body: { token?: unknown } | null
  try {
    body = (await res.json()) as { token?: unknown } | null
  } catch {
    body = null
  }
  if (!res.ok || typeof body?.token !== 'string' || body.token === '') {
    throw new ConnectError('connect_failed')
  }
  return body.token
}

/** Runs in the panel: the permission prompt needs a user gesture. */
export async function connect(address: string, opts: ConnectOptions = {}): Promise<Session> {
  const f = opts.fetchImpl ?? fetch
  const origin = originOf(address)
  if (origin === null) throw new ConnectError('invalid_address')
  const pattern = `${origin}/*`

  const hadPermission = await chrome.permissions.contains({ origins: [pattern] })
  if (!hadPermission && !(await chrome.permissions.request({ origins: [pattern] }))) {
    throw new ConnectError('permission_denied')
  }
  try {
    const found = await discover(address, f, opts.apiPath)
    if ('error' in found) throw new ConnectError(found.error)
    const { apiBase, meta } = found

    let token = opts.manualToken?.trim() || ''
    if (!token) {
      if (!meta.connect_url || !meta.features.includes('auth.exchange')) {
        throw new ConnectError('needs_manual_token')
      }
      token = await exchange(apiBase, await webFlow(meta), f)
    }

    let user
    try {
      user = (await createClient(apiBase, token, f).validate()).user
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new ConnectError('invalid_token')
      if (e instanceof ApiError) throw new ConnectError('connect_failed')
      throw new ConnectError('unreachable')
    }
    const session: Session = {
      origin,
      apiBase,
      token,
      user: { id: user.id, name: user.name, email: user.email ?? '' },
      meta,
    }
    await setSession(session)
    return session
  } catch (e) {
    if (!hadPermission) await chrome.permissions.remove({ origins: [pattern] }).catch(() => undefined)
    throw e
  }
}

/** Revoke is best effort; local cleanup always happens. */
export async function disconnect(opts: { fetchImpl?: FetchLike } = {}): Promise<void> {
  const session = await getSession()
  if (!session) return
  try {
    await createClient(session.apiBase, session.token, opts.fetchImpl ?? fetch).revoke()
  } catch {
    // ignored on purpose; the token is dropped locally either way
  }
  await clearSession()
  // Task 4 owns the poll alarm and badge; clear them only where the APIs exist.
  await chrome.alarms?.clear?.('poll')?.catch?.(() => undefined)
  await chrome.action?.setBadgeText?.({ text: '' })?.catch?.(() => undefined)
  await chrome.permissions.remove({ origins: [`${session.origin}/*`] }).catch(() => undefined)
}
