import { createBoundedCache } from "./bounded.ts";

/** Default byte budget for the rendered-fragment cache (ADR 0006). */
export const DEFAULT_FRAGMENT_CACHE_BYTES = 256 * 1024 * 1024;

export interface FragmentCacheOptions {
  readonly maxBytes?: number;
}

export type FragmentStatus = "hit" | "miss";

export interface FragmentResult {
  readonly html: string;
  readonly status: FragmentStatus;
}

export interface FragmentCache {
  /** Returns the cached fragment or renders and stores it under `key` (ADR 0006). */
  getOrRender(key: string, render: () => string | Promise<string>): Promise<FragmentResult>;
  readonly size: number;
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
}

export type FragmentKeyPart = string | number | boolean | null | undefined;

/**
 * Builds a deterministic cache key from the variant parts (ADR 0006). Parts are sorted so
 * callers never depend on object order, and `undefined` is kept apart from `""`.
 */
export function fragmentKey(parts: Readonly<Record<string, FragmentKeyPart>>): string {
  return Object.keys(parts)
    .sort()
    .map((name) => {
      const value = parts[name];
      const encoded = value === undefined ? "\u0000undefined" : String(value);
      return `${encodeURIComponent(name)}=${encodeURIComponent(encoded)}`;
    })
    .join("&");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * The in-process fragment store: a byte-bounded LRU of rendered HTML. Tag versions and the
 * listener protocol arrive with the cache stack; the spike only needs variant separation.
 */
export function createFragmentCache(options: FragmentCacheOptions = {}): FragmentCache {
  const store = createBoundedCache<string, string>({
    maxBytes: options.maxBytes ?? DEFAULT_FRAGMENT_CACHE_BYTES,
  });
  let hits = 0;
  let misses = 0;

  return {
    async getOrRender(key, render) {
      const cached = store.get(key);

      if (cached !== undefined) {
        hits += 1;
        return { html: cached, status: "hit" };
      }

      misses += 1;
      const html = await render();
      store.set(key, html, byteLength(html));
      return { html, status: "miss" };
    },

    get size() {
      return store.size;
    },

    get bytes() {
      return store.bytes;
    },

    get hits() {
      return hits;
    },

    get misses() {
      return misses;
    },
  };
}
