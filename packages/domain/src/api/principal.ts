import type { SQL } from "bun";
import { type ApiKeyPrincipal, authenticateApiKey } from "./keys.ts";
import type { ApiScope } from "./scopes.ts";

/** Guests are a real group, so a key-less request uses the same `can()` path (ADR 0004). */
export interface ApiGuestPrincipal {
  readonly kind: "guest";
  readonly scopes: readonly [];
}

export type ApiPrincipal = ApiGuestPrincipal | ApiKeyPrincipal;

export const API_GUEST_PRINCIPAL: ApiGuestPrincipal = {
  kind: "guest",
  scopes: [],
};

export function isApiKeyPrincipal(principal: ApiPrincipal): principal is ApiKeyPrincipal {
  return principal.kind === "key";
}

export type ApiAuthResult =
  | { readonly ok: true; readonly principal: ApiPrincipal }
  | { readonly ok: false; readonly code: "invalid_api_key" };

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Resolves `/api/v1` authentication from the Authorization header only (ADR 0016, 0018).
 * Cookies are deliberately never read here: a browser session cookie on `/api/v1` is ignored
 * and the request is a guest request.
 */
export async function resolveApiPrincipal(
  sql: SQL,
  request: Request,
  options: { readonly pepper: string; readonly now?: Date },
): Promise<ApiAuthResult> {
  const header = request.headers.get("authorization");

  if (header === null || header.trim() === "") {
    return { ok: true, principal: API_GUEST_PRINCIPAL };
  }

  const match = BEARER.exec(header.trim());

  if (match === null) {
    return { ok: false, code: "invalid_api_key" };
  }

  const principal = await authenticateApiKey(sql, {
    key: match[1] ?? "",
    pepper: options.pepper,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return principal === null ? { ok: false, code: "invalid_api_key" } : { ok: true, principal };
}

/**
 * Scope enforcement. A guest has no scopes and is filtered by `can()` alone; a key must also
 * carry the scope, so a narrow key can never reach a write route even if its member could.
 */
export function apiScopeAllowed(principal: ApiPrincipal, required: readonly ApiScope[]): boolean {
  if (required.length === 0 || principal.kind === "guest") {
    return true;
  }

  return required.every((scope) => principal.scopes.includes(scope));
}

export function missingApiScope(
  principal: ApiPrincipal,
  required: readonly ApiScope[],
): ApiScope | null {
  if (principal.kind === "guest") {
    return required[0] ?? null;
  }

  return required.find((scope) => !principal.scopes.includes(scope)) ?? null;
}
