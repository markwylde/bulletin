import { createRemoteJWKSet, jwtVerify } from "jose";

export type Jwks = ReturnType<typeof createRemoteJWKSet>;

export interface IdTokenClaims {
  readonly issuer: string;
  readonly sub: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly authTime: Date | null;
}

export class IdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdTokenError";
  }
}

export function createJwks(jwksUrl: string): Jwks {
  return createRemoteJWKSet(new URL(jwksUrl));
}

/**
 * Verifies a DarkAuth ID token against the JWKS (ADR 0018): signature, issuer, audience,
 * expiry and the challenge nonce. The nonce is the login-CSRF binding, so it is checked
 * here rather than by `jose`.
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
    );
  }

  if (payload.nonce !== expected.nonce) {
    throw new IdTokenError("ID token nonce does not match the challenge");
  }

  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new IdTokenError("ID token has no subject");
  }

  return {
    issuer: typeof payload.iss === "string" ? payload.iss : expected.issuer,
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    name: typeof payload.name === "string" ? payload.name : null,
    authTime: typeof payload.auth_time === "number" ? new Date(payload.auth_time * 1_000) : null,
  };
}
