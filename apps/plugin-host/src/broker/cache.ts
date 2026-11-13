import type { Logger } from "@bulletin/config";
import { TokenBucket } from "./limits.ts";

/**
 * Plugin cache invalidation (ADR 0009). Plugins may only bump tags in their own namespace;
 * `forum:3` becomes `plugin:<id>:forum:3`, so a plugin can never invalidate core output.
 * Excess calls are coalesced into one bump instead of failing: a plugin job that updates many
 * rows benefits from one invalidation, and the core stays bounded.
 *
 * Each coalescing window is its own batch. Batches flush one after another, and a caller is
 * acknowledged only when the bump that contains its tags has committed — a bump that is
 * already in flight never acknowledges a later call whose tags it did not include.
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

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface FlushBatch {
  readonly tags: Set<string>;
  readonly waiters: Waiter[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class CacheInvalidator {
  readonly #bump: BumpTags;
  readonly #logger: Logger;
  readonly #bucket: TokenBucket;
  readonly #coalesceMs: number;
  /** Tags collected since the last batch started flushing; new calls join this batch. */
  #open: FlushBatch | undefined;
  /** Batches flush one at a time, in the order they were closed. */
  #flushing: Promise<void> = Promise.resolve();
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

    const batch = this.#openBatch();
    const settled = new Promise<void>((resolve, reject) => {
      batch.waiters.push({ resolve, reject });
    });

    for (const tag of namespaced) {
      if (batch.tags.has(tag)) {
        this.#coalesced += 1;
      }

      batch.tags.add(tag);
    }

    this.#schedule(batch);
    await settled;

    return namespaced;
  }

  /** Flushes now; used on shutdown and by tests. */
  async flush(): Promise<void> {
    const batch = this.#open;

    if (batch !== undefined) {
      if (batch.timer !== undefined) {
        clearTimeout(batch.timer);
        batch.timer = undefined;
      }

      this.#enqueue(batch);
    }

    await this.#flushing;
  }

  #openBatch(): FlushBatch {
    this.#open ??= { tags: new Set(), waiters: [], timer: undefined };
    return this.#open;
  }

  #schedule(batch: FlushBatch): void {
    if (batch.timer !== undefined) {
      return;
    }

    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      this.#enqueue(batch);
    }, this.#coalesceMs);
    batch.timer.unref?.();
  }

  #enqueue(batch: FlushBatch): void {
    if (this.#open === batch) {
      this.#open = undefined;
    }

    // Custom promises keep the chain from wedging if a bump fails; the failure is reported
    // to that batch's callers instead.
    this.#flushing = this.#flushing.then(
      () => this.#run(batch),
      () => this.#run(batch),
    );
  }

  async #run(batch: FlushBatch): Promise<void> {
    const tags = [...batch.tags];
    batch.tags.clear();

    if (tags.length === 0) {
      for (const waiter of batch.waiters) {
        waiter.resolve();
      }

      return;
    }

    try {
      await this.#bump(tags);

      for (const waiter of batch.waiters) {
        waiter.resolve();
      }
    } catch (error) {
      // Keep the tags for the next attempt and fail this batch's callers instead of
      // acknowledging a bump that did not commit.
      const retry = this.#openBatch();

      for (const tag of tags) {
        retry.tags.add(tag);
      }

      const failure = error instanceof Error ? error : new Error(String(error));
      this.#logger.error("plugin.cache_invalidate_failed", { tags, error });
      for (const waiter of batch.waiters) {
        waiter.reject(failure);
      }
    }
  }
}
