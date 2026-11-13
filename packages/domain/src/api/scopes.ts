/**
 * The scopes an API key can carry (ADR 0016). A scope narrows the key's principal; it never
 * grants anything on its own, so every route still checks `can()`.
 */
export const API_SCOPES = [
  "read:forums",
  "read:topics",
  "read:posts",
  "read:members",
  "read:search",
  "write:posts",
  "write:reactions",
  "write:follows",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);

export function isApiScope(value: string): value is ApiScope {
  return SCOPE_SET.has(value);
}

/** Keeps known scopes in catalog order; unknown values are dropped. */
export function canonicalApiScopes(values: readonly string[]): readonly ApiScope[] {
  const allowed = new Set(values.filter(isApiScope));
  return API_SCOPES.filter((scope) => allowed.has(scope));
}

/** Parses a scopes column into the known values without trusting the stored array. */
export function parseApiScopes(value: unknown): readonly ApiScope[] {
  return Array.isArray(value)
    ? canonicalApiScopes(value.filter((entry): entry is string => typeof entry === "string"))
    : [];
}
