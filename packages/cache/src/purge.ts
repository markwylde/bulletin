/** Best-effort purges are capped so a slow CDN never holds up a request (ADR 0006). */
export const DEFAULT_PURGE_TIMEOUT_MS = 300;

export interface PurgeResult {
  readonly tags: readonly string[];
  /** False when the CDN could not be reached or answered with an error. */
  readonly ok: boolean;
}

export interface CdnPurger {
  purge(tags: readonly string[], options?: { readonly timeoutMs?: number }): Promise<PurgeResult>;
}

export type PurgeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CdnPurgerOptions {
  /** The CDN's surrogate-key purge endpoint. */
  readonly url: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: PurgeFetch;
}

/**
 * Calls the CDN's surrogate-key purge endpoint. Any failure is reported, never thrown: the
 * retrying path is a domain event handled by workers (ADR 0006, 0011).
 */
export function createCdnPurger(options: CdnPurgerOptions): CdnPurger {
  const fetchImpl: PurgeFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    async purge(tags, callOptions = {}) {
      if (tags.length === 0) {
        return { tags, ok: true };
      }

      const timeoutMs = callOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_PURGE_TIMEOUT_MS;

      try {
        const response = await fetchImpl(options.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keys: tags }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        return { tags, ok: response.ok };
      } catch {
        return { tags, ok: false };
      }
    },
  };
}
