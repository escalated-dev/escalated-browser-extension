import { ApiError } from '../api/errors'
import type { Client } from '../api/client'

/** The only client methods the panel may call through the worker. */
export const API_CALLS = [
  'validate',
  'dashboard',
  'listTickets',
  'getTicket',
  'reply',
  'setStatus',
  'setPriority',
  'assign',
  'applyMacro',
  'createTicket',
  'agents',
  'departments',
  'cannedResponses',
  'macros',
] as const satisfies readonly (keyof Client)[]

export type ApiCall = (typeof API_CALLS)[number]

export type ApiMessage = { type: 'api'; call: ApiCall; args: unknown[] }
export type PollNowMessage = { type: 'poll-now' }
/** Worker to panel. */
export type OpenTicketMessage = { type: 'open-ticket'; reference: string }
export type WorkerMessage = ApiMessage | PollNowMessage

export type WireError = { status: number; message: string; errors?: Record<string, string[]> }
export type ApiResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: WireError }

export const isApiCall = (v: unknown): v is ApiCall =>
  typeof v === 'string' && (API_CALLS as readonly string[]).includes(v)

/** Panel helper: typed per call; rejects with an ApiError (status 0 when the worker is unreachable). */
export async function send<C extends ApiCall>(
  call: C,
  ...args: Parameters<Client[C]>
): Promise<Awaited<ReturnType<Client[C]>>> {
  let res: ApiResponse | undefined
  try {
    res = (await chrome.runtime.sendMessage({ type: 'api', call, args } satisfies ApiMessage)) as
      ApiResponse | undefined
  } catch {
    throw new ApiError('Could not reach the background worker', 0)
  }
  if (!res) throw new ApiError('Could not reach the background worker', 0)
  if (!res.ok) {
    const extra: { errors?: Record<string, string[]> } = {}
    if (res.error.errors) extra.errors = res.error.errors
    throw new ApiError(res.error.message, res.error.status, extra)
  }
  return res.data as Awaited<ReturnType<Client[C]>>
}

export async function pollNow(): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'poll-now' } satisfies PollNowMessage)
}
