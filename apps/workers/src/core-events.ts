import type { CdnPurger } from "@bulletin/cache";
import type { Logger } from "@bulletin/config";
import type { StoredEvent } from "@bulletin/db/events";
import { forumSubtreeTags } from "@bulletin/domain/permissions";
import type { SQL } from "bun";

export interface CoreEventHandlerOptions {
  readonly sql: SQL;
  /** Absent when no CDN purge endpoint is configured (e.g. a bare test stack). */
  readonly purger?: CdnPurger;
  readonly logger?: Logger;
}

/**
 * The core subscriber's background work. The retrying CDN purge for a visibility change is
 * the fallback when the request-path purge could not reach the CDN (ADR 0006, 0011).
 */
export function createCoreEventHandler(
  options: CoreEventHandlerOptions,
): (event: StoredEvent) => Promise<void> {
  return async (event) => {
    if (event.type !== "forum.visibility.changed") {
      return;
    }

    const forumId = event.payloadIds.forumId;

    if (forumId === undefined) {
      return;
    }

    const tags = await forumSubtreeTags(options.sql, forumId);

    if (options.purger === undefined) {
      options.logger?.warn("cdn.purge.skipped", { forumId, tags, reason: "no purge endpoint" });
      return;
    }

    const result = await options.purger.purge(tags);

    if (!result.ok) {
      throw new Error(`CDN purge failed for ${tags.join(" ")}`);
    }

    options.logger?.info("cdn.purged", { forumId, tags });
  };
}
