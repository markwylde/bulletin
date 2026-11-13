import type { Logger } from "@bulletin/config";
import { TokenBucket } from "./limits.ts";

/**
 * Plugin cache invalidation (ADR 0009). Plugins may only bump tags in their own namespace;
 * `forum:3` becomes `plugin:<id>:forum:3`, so a plugin can never invalidate core output.
 * Excess calls are coalesced into one bump instead of failing: a plugin job that updates many
 * rows benefits from one invalidation, and the core stays bounded.
 */

export type BumpTags = (tags: readonly string[]) => Promise<void>;

export interface CacheInvalidatorOptions {
  readonly bump: BumpTags;
  readonly logger: Logger;
  readonly ratePerSecond?: number;
  /** Window within which repeated tags collapse into one bump. */
  readonly coalesceMs?: number;
  /** Test seam for the clock. */
  readonly now?: () => number;
}

const DEFAULT_RATE = 50;
const DEFAULT_COALESCE_MS = 5;
const MAX_TAGS = 100;
const MAX_TAG_LENGTH = 128;

export class CacheRateLimitError extends Error {
  constructor() {
    super("Plugin cache invalidation rate limit exceeded");
    this.name = "CacheRateLimitError";
  }
}

export class CacheInvalidator {
  readonly #bump: BumpTags;
  readonly #logger: Logger;
  readonly #bucket: TokenBucket;
  readonly #coalesceMs: number;
  readonly #pending = new Set<string>();
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #flushing: Promise<void> | undefined;
  #resolveFlush: (() => void) | undefined;
  #rejectFlush: ((error: Error) => void) | undefined;
  #coalesced = 0;

  constructor(options: CacheInvalidatorOptions) {
    this.#bump = options.bump;
    this.#logger = options.logger;
    this.#bucket = new TokenBucket(options.ratePerSecond ?? DEFAULT_RATE, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  }

  get coalesced(): number {
    return this.#coalesced;
  }

  /** Namespaces arbitrary input into the plugin's own tag namespace. */
  static namespace(pluginId: string, tag: string): string {
    const prefix = `plugin:${pluginId}:`;
    const stripped = tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
    return `${prefix}${stripped}`;
  }

  async invalidate(pluginId: string, tags: readonly string[]): Promise<readonly string[]> {
    const namespaced: string[] = [];

    for (const tag of tags.slice(0, MAX_TAGS)) {
      if (typeof tag !== "string" || tag.trim() === "" || tag.length > MAX_TAG_LENGTH) {
        continue;
      }

      namespaced.push(CacheInvalidator.namespace(pluginId, tag.trim()));
    }

    if (namespaced.length === 0) {
      return [];
    }

    if (!this.#bucket.take()) {
      this.#logger.warn("plugin.cache_invalidate_rate_limited", { pluginId });
      throw new CacheRateLimitError();
    }

    for (const tag of namespaced) {
      this.#pending.add(tag);
    }

    this.#schedule();
    await this.#flushing;

    return namespaced;
  }

  /** Flushes now; used on shutdown and by tests. */
  async flush(): Promise<void> {
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }

    const tags = [...this.#pending];
    this.#pending.clear();

    if (tags.length === 0) {
      this.#resolveFlush?.();
      return;
    }

    try {
      await this.#bump(tags);
      this.#resolveFlush?.();
    } catch (error) {
      // Keep the tags for the next attempt and fail the caller instead of acknowledging.
      for (const tag of tags) {
        this.#pending.add(tag);
      }

      this.#logger.error("plugin.cache_invalidate_failed", { tags, error });
      this.#rejectFlush?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.#resolveFlush = undefined;
      this.#rejectFlush = undefined;
    }
  }

  #schedule(): void {
    if (this.#flushTimer !== undefined) {
      return;
    }

    this.#flushing = new Promise<void>((resolve, reject) => {
      this.#resolveFlush = resolve;
      this.#rejectFlush = reject;
    });
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.flush().catch(() => undefined);
    }, this.#coalesceMs);
    this.#flushTimer.unref?.();
  }
}
