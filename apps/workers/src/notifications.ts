import type { Logger } from "@bulletin/config";
import type { StoredEvent } from "@bulletin/domain/events";
import {
  createNotification,
  createNotificationEmailIntent,
  eventRecipients,
  memberIsActive,
  type NotificationRecipient,
  type NotificationRecipientFilter,
  notificationChannels,
  notificationIdForEvent,
} from "@bulletin/domain/notifications";
import type { SQL } from "bun";

export interface NotificationsHandlerOptions {
  readonly sql: SQL;
  readonly logger?: Logger;
  /** Extension point for later changes (ignore list, blocks): false drops the recipient. */
  readonly filters?: readonly NotificationRecipientFilter[];
  /** Enqueues one email job after commit; a failure makes the event job retry. */
  readonly enqueueEmail?: (intentId: string) => Promise<void>;
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
    let recipients = await eventRecipients(options.sql, event);

    for (const filter of options.filters ?? []) {
      const kept: NotificationRecipient[] = [];

      for (const recipient of recipients) {
        if (await filter({ sql: options.sql, event, recipient })) {
          kept.push(recipient);
        }
      }

      recipients = kept;
    }

    if (recipients.length === 0) {
      return;
    }

    const emailIntents: string[] = [];
    await options.sql.begin(async (tx) => {
      for (const recipient of recipients) {
        if (!(await memberIsActive(tx, recipient.memberId))) {
          continue;
        }

        const channels = await notificationChannels(tx, recipient.memberId, recipient.type);

        if (!channels.in_app && !channels.email && !channels.digest) {
          continue;
        }

        const created = await createNotification(tx, {
          memberId: recipient.memberId,
          type: recipient.type,
          eventId: event.id,
          actorId: recipient.actorId,
          topicId: recipient.topicId,
          forumId: recipient.forumId,
          postId: recipient.postId,
        });
        const notificationId =
          created ?? (await notificationIdForEvent(tx, event.id, recipient.memberId));

        if (channels.email && notificationId !== null) {
          const intent = await createNotificationEmailIntent(
            tx,
            recipient.memberId,
            notificationId,
          );

          if (intent !== null) {
            emailIntents.push(intent.toString());
          }
        }
      }
    });

    for (const intent of emailIntents) {
      await options.enqueueEmail?.(intent);
    }

    options.logger?.info("notifications.created", {
      eventId: event.id.toString(),
      count: recipients.length,
    });
  };
}
