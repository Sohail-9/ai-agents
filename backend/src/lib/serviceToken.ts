import { createRemoteJWKSet, jwtVerify } from "jose";

// Remote JWKS for the PrettiFlow auth service. Cached at module scope so jose
// caches fetched keys across calls (refetches on rotation / unknown kid).
const JWKS_URL = process.env.AUTH_JWKS_URL;
const AUTH_ISSUER = process.env.AUTH_ISSUER;
const AUTH_AUDIENCE = process.env.AUTH_AUDIENCE;
const jwks = JWKS_URL ? createRemoteJWKSet(new URL(JWKS_URL)) : null;

export type ServiceIdentity = { userId: string; sessionId?: string };

/**
 * Verify a PrettiFlow auth-service RS256 access token via JWKS. Enforces issuer
 * + audience when configured; the audience MUST be the access-token audience
 * (not the OAuth/CLI-state audience) so a state token can't replay as an access
 * token. Returns the identity, or null if the token is invalid / JWKS unset.
 */
export async function verifyServiceToken(token: string): Promise<ServiceIdentity | null> {
  if (!jwks) return null;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      ...(AUTH_ISSUER ? { issuer: AUTH_ISSUER } : {}),
      ...(AUTH_AUDIENCE ? { audience: AUTH_AUDIENCE } : {}),
    });
    if (!payload.sub) return null;
    // Auth service signs the session id as the `sid` claim (jwt.service.ts).
    return { userId: payload.sub, sessionId: (payload as { sid?: string }).sid };
  } catch {
    return null;
  }
}
