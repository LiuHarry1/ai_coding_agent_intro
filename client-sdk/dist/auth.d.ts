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
export interface MintJwtOptions {
    username?: string;
    role?: string;
    ttlSeconds?: number;
    extraClaims?: Record<string, unknown>;
}
/** Create a signed HS256 JWT the agent backend will accept. */
export declare function mintJwt(secret: string, email: string, opts?: MintJwtOptions): string;
//# sourceMappingURL=auth.d.ts.map