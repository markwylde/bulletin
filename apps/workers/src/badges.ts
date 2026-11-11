import type { Logger } from "@bulletin/config";
import { evaluateBadgeRulesForEvent } from "@bulletin/domain/badges";
import type { StoredEvent } from "@bulletin/domain/events";
import type { SQL } from "bun";

/** Evaluates automatic badge rules after the events that can cross a threshold (task 5.4). */
export function createBadgeEventHandler(options: {
  readonly sql: SQL;
  readonly logger?: Logger;
}): (event: StoredEvent) => Promise<void> {
  return async (event) => {
    const awarded = await evaluateBadgeRulesForEvent(options.sql, event);

    if (awarded > 0) {
      options.logger?.info("badges.awarded", { eventId: event.id.toString(), awarded });
    }
  };
}
