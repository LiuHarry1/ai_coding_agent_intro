/**
 * Local HS256 JWT minting for the coding-agent backend.
 *
 * Mirrors ``client-sdk-py/agent_client/auth.py``. The SSO deploy mode verifies
 * a shared-secret HS256 token statelessly — callers can mint their own token
 * instead of going through the browser SSO flow.
 *
 * Node-only (uses ``node:crypto``). Browser callers should pass a ready-made
 * ``token`` or set ``Authorization`` via ``headers``.
 */

import { createHmac } from 'node:crypto'

export interface MintJwtOptions {
  username?: string
  role?: string
  ttlSeconds?: number
  extraClaims?: Record<string, unknown>
}

function b64url(raw: Buffer): string {
  return raw.toString('base64url')
}

/** Create a signed HS256 JWT the agent backend will accept. */
export function mintJwt(
  secret: string,
  email: string,
  opts: MintJwtOptions = {},
): string {
  if (!secret) throw new Error('mintJwt: secret is required')
  if (!email) throw new Error('mintJwt: email is required')

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload: Record<string, unknown> = {
    sub: email,
    username: opts.username ?? email,
    role: opts.role ?? 'user',
    iat: now,
    exp: now + (opts.ttlSeconds ?? 3600),
    ...opts.extraClaims,
  }

  const signingInput =
    b64url(Buffer.from(JSON.stringify(header))) +
    '.' +
    b64url(Buffer.from(JSON.stringify(payload)))

  const signature = createHmac('sha256', secret).update(signingInput).digest()
  return signingInput + '.' + b64url(signature)
}
