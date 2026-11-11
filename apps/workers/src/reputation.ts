import type { Logger } from "@bulletin/config";
import type { StoredEvent } from "@bulletin/db/events";
import { REPUTATION_RECOUNT_QUEUE } from "@bulletin/db/jobs";
import type { PgBoss } from "pg-boss";

export interface ReputationEventHandlerOptions {
  readonly boss: PgBoss;
  readonly logger?: Logger;
}

/**
 * The reputation subscriber. The board toggle only records that a recount is needed; the
 * worker coalesces concurrent requests onto one job with a stable singleton key (ADR 0011).
 */
export function createReputationEventHandler(
  options: ReputationEventHandlerOptions,
): (event: StoredEvent) => Promise<void> {
  return async (event) => {
    if (event.type !== "reputation.recount.requested") {
      return;
    }

    await options.boss.send(
      REPUTATION_RECOUNT_QUEUE,
      { reason: "board-setting" },
      { singletonKey: "reputation:recount" },
    );
    options.logger?.info("reputation.recount.enqueued", { eventId: String(event.id) });
  };
}
