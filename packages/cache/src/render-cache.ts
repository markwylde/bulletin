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
  /** Optional fragment TTL in milliseconds (ADR 0006 time-based transitions). */
  readonly ttlMs?: number;
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
  /** Test seam for fragment expiry. */
  readonly now?: () => number;
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
  /** Wall-clock expiry for time-based transitions; null means no TTL. */
  readonly expiresAt: number | null;
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
  const now = options.now ?? Date.now;

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

  function bypassResult(key: string, html: string, tags: readonly string[]): RenderResult {
    bypasses += 1;

    return { key, html, status: "bypass", tags, versions: snapshot(tags) };
  }

  return {
    async getOrRender<T>(request: RenderRequest<T>) {
      if (!(await trusted())) {
        const prepared = await request.prepare();

        return bypassResult(prepared.key, await request.render(prepared.data), request.tags);
      }

      let key = "";
      let html = "";

      for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt += 1) {
        const current = snapshot(request.tags);
        const prepared = await request.prepare();

        key = prepared.key;

        // `prepare()` awaited. A listener failure during it means the versions just captured
        // can no longer be trusted, so serve the fresh render as BYPASS and store nothing.
        if (!(await trusted())) {
          return bypassResult(key, await request.render(prepared.data), request.tags);
        }

        const preparedVersions = snapshot(request.tags);
        const cached = store.get(key);
        const live =
          cached !== undefined && (cached.expiresAt === null || cached.expiresAt > now());

        if (cached !== undefined && live && sameVersions(cached.versions, preparedVersions)) {
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

        // `render()` awaited. Recheck trust before returning the HTML and, below, before
        // storing it: a listener loss must fail closed even mid-render.
        if (!(await trusted())) {
          return bypassResult(key, html, request.tags);
        }

        const next = snapshot(request.tags);

        if (sameVersions(next, current) && sameVersions(preparedVersions, current)) {
          misses += 1;
          store.set(
            key,
            {
              html,
              versions: current,
              expiresAt: prepared.ttlMs === undefined ? null : now() + Math.max(0, prepared.ttlMs),
            },
            Buffer.byteLength(html, "utf8"),
          );

          return { key, html, status: "miss", tags: request.tags, versions: current };
        }

        // A tag moved while the data was loaded or rendered, so the snapshot this HTML was
        // built from may already be older than the invalidation. Load again instead of storing
        // stale HTML under a newer version.
      }

      // The tags kept moving for every attempt: serve this render but store nothing.
      if (!(await trusted())) {
        return bypassResult(key, html, request.tags);
      }

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
