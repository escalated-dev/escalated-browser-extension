import { createClient, type FetchLike } from '../api/client'
import { getSession, setSession } from '../state/storage'

/**
 * Re-reads /meta for the connected helpdesk, so features turned on or off after the connect take
 * effect. The answer is sanitised like at connect. Any failure keeps the stored meta. Writing the
 * session updates the panel and the context menu through storage.onChanged.
 */
export async function refreshMeta(fetchImpl: FetchLike = fetch): Promise<void> {
  const session = await getSession()
  if (!session) return
  let meta
  try {
    meta = await createClient(session.apiBase, session.token, fetchImpl).meta()
  } catch {
    return
  }
  if (typeof meta.api_version !== 'string') return
  const current = await getSession()
  if (!current || current.token !== session.token || current.apiBase !== session.apiBase) return
  if (JSON.stringify(current.meta) === JSON.stringify(meta)) return
  await setSession({ ...current, meta })
}
