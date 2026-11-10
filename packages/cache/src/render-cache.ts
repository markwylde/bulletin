import { createBoundedCache } from "./bounded.ts";
import type { TagVersionSource } from "./tags.ts";

/** Default byte budget for the rendered-page cache (ADR 0006). */
export const DEFAULT_RENDER_CACHE_BYTES = 256 * 1024 * 1024;

/** A tag set that keeps moving during one render is served uncached, never stored stale. */
const MAX_RENDER_ATTEMPTS = 3;

/** `bypass` is the fail-closed mode while invalidations are not trusted (ADR 0006). */
export type RenderStatus = "hit" | "miss" | "bypass";

/** What a request's `prepare` returns: the variant key plus the view-model inputs. */
export interface PreparedRender<T = undefined> {
  /** The variant key; it may depend on the loaded data (e.g. a permission visibility key). */
  readonly key: string;
  /** Everything the HTML render needs, loaded after the tag snapshot. */
  readonly data: T;
}

export interface RenderRequest<T = undefined> {
  /** Every tag this fragment depends on. */
  readonly tags: readonly string[];
  /**
   * Loads the view-model data and computes the key. The cache calls this *after* capturing the
   * tag versions, so the data behind an entry can never be older than the versions it is
   * stored under (ADR 0006). It runs again when a tag moves during the attempt.
   */
  readonly prepare: () => Promise<PreparedRender<T>>;
  /** Produces the fragment from the prepared data; rendered only on a miss. */
  readonly render: (data: T) => string | Promise<string>;
}

export interface RenderResult {
  readonly key: string;
  readonly html: string;
  readonly status: RenderStatus;
  readonly tags: readonly string[];
  /**
   * The tag versions that describe this HTML (ADR 0006). They are captured before the data is
   * loaded, so an invalidation during the render can never pair old HTML with a newer ETag.
   */
  readonly versions: ReadonlyMap<string, string>;
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
  getOrRender<T = undefined>(request: RenderRequest<T>): Promise<RenderResult>;
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

function sameVersions(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return (
    left.size === right.size && [...right].every(([tag, version]) => left.get(tag) === version)
  );
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
    async getOrRender<T>(request: RenderRequest<T>) {
      if (!(await trusted())) {
        bypasses += 1;
        const prepared = await request.prepare();
        const html = await request.render(prepared.data);

        return {
          key: prepared.key,
          html,
          status: "bypass",
          tags: request.tags,
          versions: snapshot(request.tags),
        };
      }

      let key = "";
      let html = "";

      for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt += 1) {
        const current = snapshot(request.tags);
        const prepared = await request.prepare();

        key = prepared.key;
        const cached = store.get(key);

        if (cached !== undefined && sameVersions(cached.versions, current)) {
          hits += 1;
          return {
            key,
            html: cached.html,
            status: "hit",
            tags: request.tags,
            versions: cached.versions,
          };
        }

        html = await request.render(prepared.data);
        const next = snapshot(request.tags);

        if (sameVersions(next, current)) {
          misses += 1;
          store.set(key, { html, versions: current }, Buffer.byteLength(html, "utf8"));

          return { key, html, status: "miss", tags: request.tags, versions: current };
        }

        // A tag moved while the data was loaded or rendered, so the snapshot this HTML was
        // built from may already be older than the invalidation. Load again instead of storing
        // stale HTML under a newer version.
      }

      // The tags kept moving for every attempt: serve this render but store nothing.
      misses += 1;

      return {
        key,
        html,
        status: "miss",
        tags: request.tags,
        versions: snapshot(request.tags),
      };
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
