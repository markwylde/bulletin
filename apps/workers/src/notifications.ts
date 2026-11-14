import type { Logger } from "@bulletin/config";
import { ensurePgBossQueue } from "@bulletin/db/events";
import { loadEvent, type StoredEvent } from "@bulletin/domain/events";
import {
  createNotification,
  createNotificationEmailIntent,
  createNotificationPushIntent,
  eventRecipients,
  memberIsActive,
  type NotificationRecipient,
  type NotificationRecipientFilter,
  notificationChannels,
  notificationIdForEvent,
} from "@bulletin/domain/notifications";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import type { WorkerFlags } from "./flags.ts";

/** One fan-out job covers at most this many recipients (ADR 0011 design). */
export const NOTIFICATION_FANOUT_CHUNK = 500;
export const NOTIFICATION_FANOUT_QUEUE = "notifications.fanout";

export interface FanoutJob {
  readonly eventId: string;
  /** Member-id boundaries, so a recipient change cannot shift another chunk's range. */
  readonly afterMemberId: string;
  readonly throughMemberId: string;
}

export interface NotificationsHandlerOptions {
  readonly sql: SQL;
  readonly logger?: Logger;
  /** Extension point for later changes (ignore list, blocks): false drops the recipient. */
  readonly filters?: readonly NotificationRecipientFilter[];
  /** Enqueues one email job after commit; a failure makes the event job retry. */
  readonly enqueueEmail?: (intentId: string) => Promise<void>;
  /** Enqueues one push job after commit; a failure makes the event job retry. */
  readonly enqueuePush?: (intentId: string) => Promise<void>;
  /** Enqueues one bounded fan-out job; absent in tests (they process inline in chunks). */
  readonly enqueueFanout?: (job: FanoutJob) => Promise<void>;
  readonly flags?: WorkerFlags;
}

function byMemberId(left: NotificationRecipient, right: NotificationRecipient): number {
  const a = BigInt(left.memberId);
  const b = BigInt(right.memberId);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The recipients that may receive this event now: recipient filters, the notifications and
 * follows flags, and the erasure fence. Sorted by member id so fan-out chunks are deterministic.
 */
export async function eligibleRecipients(
  options: NotificationsHandlerOptions,
  event: StoredEvent,
): Promise<readonly NotificationRecipient[]> {
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

  const eligible: NotificationRecipient[] = [];

  for (const recipient of recipients) {
    if (options.flags !== undefined) {
      if (!(await options.flags.enabled("notifications", recipient.memberId))) {
        continue;
      }

      if (
        recipient.source === "follow" &&
        !(await options.flags.enabled("follows", recipient.memberId))
      ) {
        continue;
      }

      if (
        recipient.type === "friend.accepted" &&
        !(await options.flags.enabled("friends", recipient.memberId))
      ) {
        continue;
      }

      if (
        recipient.type === "badge.awarded" &&
        !(await options.flags.enabled("badges", recipient.memberId))
      ) {
        continue;
      }

      if (
        recipient.type === "conversation.message" &&
        !(await options.flags.enabled("conversations", recipient.memberId))
      ) {
        continue;
      }
    }

    if (await memberIsActive(options.sql, recipient.memberId)) {
      eligible.push(recipient);
    }
  }

  return eligible.sort(byMemberId);
}

/**
 * Writes notifications and email intents for one bounded chunk, in its own transaction.
 * `notification_events` keeps a retried chunk idempotent.
 */
export async function processNotificationRecipients(
  options: NotificationsHandlerOptions,
  event: StoredEvent,
  recipients: readonly NotificationRecipient[],
): Promise<number> {
  if (recipients.length === 0) {
    return 0;
  }

  const emailIntents: string[] = [];
  const pushIntents: string[] = [];
  await options.sql.begin(async (tx) => {
    for (const recipient of recipients) {
      const channels = await notificationChannels(tx, recipient.memberId, recipient.type);

      if (!channels.in_app && !channels.email && !channels.digest && !channels.push) {
        continue;
      }

      const created = await createNotification(tx, {
        memberId: recipient.memberId,
        type: recipient.type,
        eventId: event.id,
        actorId: recipient.actorId,
        contributorId: recipient.contributorId ?? recipient.actorId,
        topicId: recipient.topicId,
        forumId: recipient.forumId,
        postId: recipient.postId,
        conversationId: recipient.conversationId ?? null,
        warningId: recipient.warningId ?? null,
      });
      const notificationId =
        created ?? (await notificationIdForEvent(tx, event.id, recipient.memberId));

      if (channels.email && notificationId !== null) {
        const intent = await createNotificationEmailIntent(
          tx,
          recipient.memberId,
          notificationId,
          event.id,
        );

        if (intent !== null) {
          emailIntents.push(intent.toString());
        }
      }

      if (channels.push && notificationId !== null) {
        const intent = await createNotificationPushIntent(
          tx,
          recipient.memberId,
          notificationId,
          event.id,
        );

        if (intent !== null) {
          pushIntents.push(intent.toString());
        }
      }
    }
  });

  for (const intent of emailIntents) {
    await options.enqueueEmail?.(intent);
  }

  for (const intent of pushIntents) {
    await options.enqueuePush?.(intent);
  }

  return recipients.length;
}

/**
 * The `notifications` subscriber. Large recipient sets are split into bounded fan-out jobs so no
 * single transaction or job handles an unbounded number of recipients (ADR 0011).
 */
export function createNotificationsEventHandler(
  options: NotificationsHandlerOptions,
): (event: StoredEvent) => Promise<void> {
  return async (event) => {
    const eligible = await eligibleRecipients(options, event);

    if (eligible.length === 0) {
      return;
    }

    if (eligible.length > NOTIFICATION_FANOUT_CHUNK && options.enqueueFanout !== undefined) {
      let afterMemberId = "0";
      let chunks = 0;

      for (let start = 0; start < eligible.length; start += NOTIFICATION_FANOUT_CHUNK) {
        const chunk = eligible.slice(start, start + NOTIFICATION_FANOUT_CHUNK);
        const throughMemberId = chunk[chunk.length - 1]?.memberId ?? afterMemberId;

        await options.enqueueFanout({
          eventId: event.id.toString(),
          afterMemberId,
          throughMemberId,
        });
        afterMemberId = throughMemberId;
        chunks += 1;
      }

      options.logger?.info("notifications.fanned_out", {
        eventId: event.id.toString(),
        recipients: eligible.length,
        chunks,
      });
      return;
    }

    let processed = 0;

    for (let start = 0; start < eligible.length; start += NOTIFICATION_FANOUT_CHUNK) {
      processed += await processNotificationRecipients(
        options,
        event,
        eligible.slice(start, start + NOTIFICATION_FANOUT_CHUNK),
      );
    }

    options.logger?.info("notifications.created", {
      eventId: event.id.toString(),
      count: processed,
    });
  };
}

/**
 * Processes one stable member-id range. Permissions are rechecked inside the range, so a member
 * who lost access is skipped without shifting anyone else's batch.
 */
export async function processNotificationChunk(
  options: NotificationsHandlerOptions,
  event: StoredEvent,
  job: FanoutJob,
): Promise<number> {
  const eligible = await eligibleRecipients(options, event);
  const after = BigInt(job.afterMemberId);
  const through = BigInt(job.throughMemberId);
  const chunk = eligible.filter((recipient) => {
    const id = BigInt(recipient.memberId);
    return id > after && id <= through;
  });

  return processNotificationRecipients(options, event, chunk);
}

export interface NotificationsFanoutWorkerOptions extends NotificationsHandlerOptions {
  readonly boss: PgBoss;
}

export interface NotificationsFanoutWorker {
  stop(): Promise<void>;
}

/** Consumes the bounded fan-out jobs created by the event handler. */
export async function createNotificationsFanoutWorker(
  options: NotificationsFanoutWorkerOptions,
): Promise<NotificationsFanoutWorker> {
  await ensurePgBossQueue(options.boss, NOTIFICATION_FANOUT_QUEUE);

  await options.boss.work<FanoutJob>(NOTIFICATION_FANOUT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const event = await loadEvent(options.sql, BigInt(job.data.eventId));

      if (event === null) {
        continue;
      }

      const processed = await processNotificationChunk(options, event, job.data);

      options.logger?.info("notifications.chunk", {
        eventId: job.data.eventId,
        throughMemberId: job.data.throughMemberId,
        count: processed,
      });
    }
  });

  return {
    stop: () => options.boss.offWork(NOTIFICATION_FANOUT_QUEUE),
  };
}
