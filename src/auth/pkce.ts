const b64url = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const randomBase64Url = (byteLength: number): string =>
  b64url(crypto.getRandomValues(new Uint8Array(byteLength)))

/** base64url (no padding) of the SHA-256 of the ASCII verifier. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return b64url(new Uint8Array(digest))
}

/** 32 random bytes give a 43 character verifier. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url(32)
  return { verifier, challenge: await challengeFor(verifier) }
}
