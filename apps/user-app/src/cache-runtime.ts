import {
  createRenderCache,
  createTagVersions,
  type RenderCache,
  type TagVersionSource,
  type TagVersions,
} from "@bulletin/cache";
import { listenSqlFromEnv } from "@bulletin/config/server";
import type { SQL } from "bun";

export interface CacheRuntime {
  readonly cache: RenderCache;
  /** Null when the LISTEN connection is not established; the cache then bypasses. */
  readonly tags: TagVersions | null;
}

export interface CacheRuntimeOptions {
  readonly connect: () => Promise<TagVersions>;
  /** First retry delay; doubles per failed attempt up to `retryMaxMs` (ADR 0006). */
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly onUnavailable?: (error: unknown) => void;
}

export interface CacheRuntimeController {
  /** The current runtime; retries in the background until the listener is connected. */
  get(): Promise<CacheRuntime>;
  close(): Promise<void>;
}

const UNTRUSTED: TagVersionSource = { version: () => "0", isTrusted: () => false };

/**
 * One render cache and tag listener per process (ADR 0001, 0006). While the listener cannot be
 * established the cache fails closed (bypass), but startup is retried with exponential
 * backoff: a database that is briefly unavailable must not disable caching for the process's
 * whole lifetime. The fallback runtime is stable, so every request in the meantime shares one
 * cache object and keeps bypassing.
 */
export function createCacheRuntime(options: CacheRuntimeOptions): CacheRuntimeController {
  const retryBaseMs = options.retryBaseMs ?? 1_000;
  const retryMaxMs = options.retryMaxMs ?? 30_000;
  const fallback: CacheRuntime = {
    tags: null,
    cache: createRenderCache({ tags: UNTRUSTED }),
  };
  let trusted: CacheRuntime | null = null;
  let attempt: Promise<CacheRuntime> | null = null;
  let retryAt: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let delayMs = retryBaseMs;
  let closed = false;

  async function start(): Promise<CacheRuntime> {
    try {
      const tags = await options.connect();

      if (closed) {
        await tags.close();
        return fallback;
      }

      trusted = { tags, cache: createRenderCache({ tags }) };
      delayMs = retryBaseMs;
      return trusted;
    } catch (error) {
      options.onUnavailable?.(error);
      scheduleRetry();
      return fallback;
    }
  }

  function scheduleRetry(): void {
    if (closed || retryTimer !== null) {
      return;
    }

    retryAt = Date.now() + delayMs;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryAt = null;
      void get();
    }, delayMs);
    retryTimer.unref?.();
    delayMs = Math.min(delayMs * 2, retryMaxMs);
  }

  async function get(): Promise<CacheRuntime> {
    if (closed) {
      return fallback;
    }

    if (trusted !== null) {
      return trusted;
    }

    // Between attempts the fallback keeps requests fail-closed without hammering the database.
    if (retryAt !== null) {
      return fallback;
    }

    attempt ??= start().finally(() => {
      attempt = null;
    });

    return attempt;
  }

  return {
    get,
    async close() {
      closed = true;

      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }

      retryAt = null;
      const current = trusted;
      trusted = null;
      await current?.tags?.close();
    },
  };
}

let controller: CacheRuntimeController | null = null;
let listenSql: SQL | undefined;

/** The process-wide render cache; created on first use and retried until connected. */
export function cacheRuntime(sql: SQL): Promise<CacheRuntime> {
  controller ??= createCacheRuntime({
    connect: () => {
      // One dedicated LISTEN client per process (ADR 0003), reused across reconnects.
      listenSql ??= listenSqlFromEnv(sql, process.env);
      return createTagVersions({ sql, listenSql });
    },
    onUnavailable: (error) => {
      console.warn("[cache] tag listener unavailable; bypassing the render cache", error);
    },
  });

  return controller.get();
}

export async function closeCacheRuntime(): Promise<void> {
  const current = controller;
  controller = null;
  await current?.close();
}
