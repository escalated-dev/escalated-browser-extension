import { ApiError } from '../api/errors'
import {
  createClient,
  discover,
  normaliseAddress,
  type FetchLike,
  type Meta,
  type Session,
} from '../api/client'
import { clearSession, getSession, LAST_ADDRESS_KEY, setSession } from '../state/storage'
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
  | 'forbidden'
  | 'insecure_connect_url'

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
    const u = new URL(normaliseAddress(address))
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
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
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('client_name', 'Chrome')

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
  const expected = new URL(redirectUri)
  if (back.origin !== expected.origin || back.pathname !== expected.pathname) {
    throw new ConnectError('connect_failed')
  }

  if (back.searchParams.get('state') !== state) throw new ConnectError('state_mismatch')
  const error = back.searchParams.get('error')
  if (error) throw new ConnectError(error === 'access_denied' ? 'denied' : 'connect_failed')
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

const REVOKE_TIMEOUT_MS = 5000

const settled = (): void => undefined

/**
 * Sends POST /auth/revoke at once and resolves when it settles or after five seconds. Never rejects.
 * Callers start it before giving up the host permission: without that permission, the panel's
 * cross-origin request with an Authorization header needs a CORS preflight the API does not
 * answer, so it would never reach the helpdesk.
 */
function startRevoke(apiBase: string, token: string, f: FetchLike): Promise<void> {
  const timed: FetchLike = (input, init) =>
    f(input, { ...init, signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) })
  let request: Promise<unknown>
  try {
    request = createClient(apiBase, token, timed).revoke()
  } catch {
    request = Promise.resolve()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, REVOKE_TIMEOUT_MS)
  })
  return Promise.race([request.then(settled, settled), timeout]).finally(() => clearTimeout(timer))
}

/** Removes one origin at a time: Chrome rejects a whole call that names a required permission. */
async function removeOrigins(origins: string[]): Promise<void> {
  for (const o of origins) {
    try {
      await chrome.permissions.remove({ origins: [o] })
    } catch {
      // best effort
    }
  }
}

/** One helpdesk at a time: after a connect, only the connected origin keeps host access. */
async function keepOnlyOrigin(pattern: string): Promise<void> {
  let granted: string[]
  try {
    granted = (await chrome.permissions.getAll()).origins ?? []
  } catch {
    return
  }
  await removeOrigins(granted.filter((o) => o !== pattern))
}

/** Runs in the panel: the permission prompt needs a user gesture. */
export async function connect(address: string, opts: ConnectOptions = {}): Promise<Session> {
  const f = opts.fetchImpl ?? fetch
  const origin = originOf(address)
  if (origin === null) throw new ConnectError('invalid_address')
  const pattern = `${origin}/*`

  // Both calls start synchronously so the prompt keeps the click's user activation.
  const q = { origins: [pattern] }
  const had = chrome.permissions.contains(q)
  const asked = chrome.permissions.request(q)
  const [hadPermission, ok] = await Promise.all([had, asked])
  if (!ok) throw new ConnectError('permission_denied')
  // A token this call got from /auth/exchange is revoked again if the connect fails after that.
  let exchanged: { apiBase: string; token: string } | null = null
  let stored = false
  try {
    const found = await discover(address, f, opts.apiPath)
    if ('error' in found) throw new ConnectError(found.error)
    const { apiBase, meta } = found

    let token = opts.manualToken?.trim() || ''
    if (!token) {
      const canExchange = meta.features.includes('auth.exchange')
      if (!meta.connect_url || !canExchange) {
        throw new ConnectError(
          canExchange && found.insecureConnectUrl ? 'insecure_connect_url' : 'needs_manual_token',
        )
      }
      token = await exchange(apiBase, await webFlow(meta), f)
      exchanged = { apiBase, token }
    }

    let user
    try {
      user = (await createClient(apiBase, token, f).validate()).user
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new ConnectError('invalid_token')
      if (e instanceof ApiError && e.status === 403) throw new ConnectError('forbidden')
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
    const old = await getSession()
    if (old && old.origin !== origin) {
      await dropSession(old, startRevoke(old.apiBase, old.token, f))
    } else if (old && old.token !== token) {
      // Same helpdesk, new token: the old one would otherwise stay valid on the server.
      await startRevoke(old.apiBase, old.token, f)
    }
    await setSession(session)
    stored = true
    await keepOnlyOrigin(pattern)
    return session
  } catch (e) {
    if (exchanged && !stored) await startRevoke(exchanged.apiBase, exchanged.token, f)
    if (!hadPermission) await chrome.permissions.remove({ origins: [pattern] }).catch(() => undefined)
    throw e
  }
}

/**
 * Every local step runs even if another throws. The caller started the revoke request while host
 * access was still held; the origin permission goes only once that request has settled.
 */
async function dropSession(session: Session, revoked: Promise<void>): Promise<void> {
  try {
    await clearSession()
  } finally {
    try {
      await chrome.alarms?.clear?.('poll')
      await chrome.action?.setBadgeText?.({ text: '' })
    } catch {
      // best effort
    } finally {
      await revoked
      await removeOrigins([`${session.origin}/*`])
    }
  }
}

/**
 * The panel's Disconnect: start the revoke, delete everything the extension stored (local and
 * session storage, and the remembered address), then give up the host permission.
 */
export async function disconnect(opts: { fetchImpl?: FetchLike } = {}): Promise<void> {
  const session = await getSession()
  const revoked = session
    ? startRevoke(session.apiBase, session.token, opts.fetchImpl ?? fetch)
    : Promise.resolve()
  try {
    localStorage.removeItem(LAST_ADDRESS_KEY)
  } catch {
    // Not available outside a page.
  }
  try {
    await chrome.storage.session.clear()
  } catch {
    // best effort
  }
  if (session) await dropSession(session, revoked)
}
