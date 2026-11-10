import { createBoundedCache } from "./bounded.ts";
import type { TagVersionSource } from "./tags.ts";

/** Default byte budget for the rendered-page cache (ADR 0006). */
export const DEFAULT_RENDER_CACHE_BYTES = 256 * 1024 * 1024;

/** `bypass` is the fail-closed mode while invalidations are not trusted (ADR 0006). */
export type RenderStatus = "hit" | "miss" | "bypass";

export interface RenderRequest {
  /** The variant key; see `variantKey`. */
  readonly key: string;
  /** Every tag this fragment depends on. */
  readonly tags: readonly string[];
  readonly render: () => string | Promise<string>;
}

export interface RenderResult {
  readonly html: string;
  readonly status: RenderStatus;
  readonly tags: readonly string[];
}

export interface RenderCacheOptions {
  readonly tags: TagVersionSource;
  readonly maxBytes?: number;
}

export interface RenderCache {
  /**
   * Serves the cached HTML when every declared tag version still matches, renders and stores
   * it otherwise, and bypasses the cache entirely when the listener is not trusted.
   */
  getOrRender(request: RenderRequest): Promise<RenderResult>;
  readonly size: number;
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly bypasses: number;
}

interface Entry {
  readonly html: string;
  readonly versions: ReadonlyMap<string, string>;
}

export function createRenderCache(options: RenderCacheOptions): RenderCache {
  const store = createBoundedCache<string, Entry>({
    maxBytes: options.maxBytes ?? DEFAULT_RENDER_CACHE_BYTES,
  });
  let hits = 0;
  let misses = 0;
  let bypasses = 0;

  function snapshot(tags: readonly string[]): Map<string, string> {
    return new Map(tags.map((tag) => [tag, options.tags.version(tag)]));
  }

  async function trusted(): Promise<boolean> {
    try {
      await options.tags.ensurePermFresh?.();
    } catch {
      // The backstop could not reach Postgres: fail closed rather than trust local versions.
      return false;
    }

    return options.tags.isTrusted();
  }

  return {
    async getOrRender(request) {
      if (!(await trusted())) {
        bypasses += 1;
        return { html: await request.render(), status: "bypass", tags: request.tags };
      }

      const current = snapshot(request.tags);
      const cached = store.get(request.key);

      if (
        cached !== undefined &&
        cached.versions.size === current.size &&
        [...current].every(([tag, version]) => cached.versions.get(tag) === version)
      ) {
        hits += 1;
        return { html: cached.html, status: "hit", tags: request.tags };
      }

      misses += 1;
      const html = await request.render();
      store.set(request.key, { html, versions: current }, Buffer.byteLength(html, "utf8"));
      return { html, status: "miss", tags: request.tags };
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

    get bypasses() {
      return bypasses;
    },
  };
}
