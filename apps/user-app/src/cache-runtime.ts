import {
  createRenderCache,
  createTagVersions,
  type RenderCache,
  type TagVersionSource,
  type TagVersions,
} from "@bulletin/cache";
import type { SQL } from "bun";

export interface CacheRuntime {
  readonly cache: RenderCache;
  /** Null when the LISTEN connection could not be established; the cache then bypasses. */
  readonly tags: TagVersions | null;
}

const UNTRUSTED: TagVersionSource = { version: () => "0", isTrusted: () => false };

let started: Promise<CacheRuntime> | null = null;

async function start(sql: SQL): Promise<CacheRuntime> {
  try {
    const tags = await createTagVersions({ sql });

    return { tags, cache: createRenderCache({ tags }) };
  } catch (error) {
    console.warn("[cache] tag listener unavailable; bypassing the render cache", error);
    return { tags: null, cache: createRenderCache({ tags: UNTRUSTED }) };
  }
}

/** One render cache and tag listener per process, started on first use (ADR 0001, 0006). */
export function cacheRuntime(sql: SQL): Promise<CacheRuntime> {
  started ??= start(sql);
  return started;
}

export async function closeCacheRuntime(): Promise<void> {
  const runtime = started === null ? null : await started.catch(() => null);
  started = null;
  await runtime?.tags?.close();
}
