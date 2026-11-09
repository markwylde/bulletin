import { createRemoteJWKSet, jwtVerify } from "jose";

export type Jwks = ReturnType<typeof createRemoteJWKSet>;

export interface IdTokenClaims {
  readonly issuer: string;
  readonly sub: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly authTime: Date | null;
}

export type IdTokenErrorKind = "network" | "denied";

export class IdTokenError extends Error {
  readonly kind: IdTokenErrorKind;

  constructor(message: string, kind: IdTokenErrorKind) {
    super(message);
    this.name = "IdTokenError";
    this.kind = kind;
  }
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "JWKSTimeout" || error.name === "JWKSFetchError") {
    return true;
  }

  if (error instanceof TypeError) {
    return true;
  }

  return /fetch failed|network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out/i.test(
    error.message,
  );
}

export function createJwks(jwksUrl: string): Jwks {
  return createRemoteJWKSet(new URL(jwksUrl));
}

/**
 * Verifies a DarkAuth ID token against the JWKS (ADR 0018): signature, issuer, audience,
 * expiry and the challenge nonce. The nonce is the login-CSRF binding, so it is checked
 * here rather than by `jose`. Network failures are distinguished from denials so the
 * silent re-auth callback can apply the outage grace.
 */
export async function verifyIdToken(
  jwks: Jwks,
  expected: { readonly issuer: string; readonly clientId: string; readonly nonce: string },
  token: string,
): Promise<IdTokenClaims> {
  let payload: Record<string, unknown>;

  try {
    const verified = await jwtVerify(token, jwks, {
      issuer: expected.issuer,
      audience: expected.clientId,
      algorithms: ["EdDSA", "RS256", "ES256"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    throw new IdTokenError(
      error instanceof Error ? `ID token rejected: ${error.message}` : "ID token rejected",
      isNetworkError(error) ? "network" : "denied",
    );
  }

  if (payload.nonce !== expected.nonce) {
    throw new IdTokenError("ID token nonce does not match the challenge", "denied");
  }

  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new IdTokenError("ID token has no subject", "denied");
  }

  return {
    issuer: typeof payload.iss === "string" ? payload.iss : expected.issuer,
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    name: typeof payload.name === "string" ? payload.name : null,
    authTime: typeof payload.auth_time === "number" ? new Date(payload.auth_time * 1_000) : null,
  };
}
