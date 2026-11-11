import type { Logger } from "@bulletin/config";
import type { StoredEvent } from "@bulletin/domain/events";
import { createNotification, eventRecipients } from "@bulletin/domain/notifications";
import type { SQL } from "bun";

export interface NotificationsHandlerOptions {
  readonly sql: SQL;
  readonly logger?: Logger;
}

/**
 * The `notifications` subscriber. Recipients are computed from current state and every
 * recipient passes `can()` inside `eventRecipients`; the insert is idempotent per
 * `(event_id, member)` so a retried job cannot duplicate a notification (ADR 0011).
 */
export function createNotificationsEventHandler(
  options: NotificationsHandlerOptions,
): (event: StoredEvent) => Promise<void> {
  return async (event) => {
    const recipients = await eventRecipients(options.sql, event);

    if (recipients.length === 0) {
      return;
    }

    await options.sql.begin(async (tx) => {
      for (const recipient of recipients) {
        await createNotification(tx, {
          memberId: recipient.memberId,
          type: recipient.type,
          eventId: event.id,
          actorId: recipient.actorId,
          topicId: recipient.topicId,
          forumId: recipient.forumId,
          postId: recipient.postId,
        });
      }
    });

    options.logger?.info("notifications.created", {
      eventId: event.id.toString(),
      count: recipients.length,
    });
  };
}
