import { describe, expect, it } from 'vitest'
import { challengeFor, createPkce } from '../../src/auth/pkce'

describe('pkce', () => {
  it('matches the RFC 7636 vector', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('creates a 43 char unreserved verifier with a matching challenge', async () => {
    const { verifier, challenge } = await createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/)
    expect(challenge).toBe(await challengeFor(verifier))
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('does not repeat', async () => {
    expect((await createPkce()).verifier).not.toBe((await createPkce()).verifier)
  })
})
