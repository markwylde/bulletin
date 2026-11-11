import type { SQL } from "bun";
import type { StoredEvent } from "../events/outbox.ts";
import { can } from "../permissions/can.ts";
import { loadForumTree } from "../permissions/tree-store.ts";

export interface NotificationRecipient {
  readonly memberId: string;
  readonly type: NotificationType;
  readonly actorId: string | null;
  readonly topicId: string | null;
  readonly forumId: string | null;
  readonly postId: string | null;
}

async function readTopic(
  sql: SQL,
  topicId: string,
): Promise<{
  readonly starterId: string;
  readonly forumId: string;
} | null> {
  const [topic] = (await sql`
    SELECT starter_id, forum_id
    FROM core.topics
    WHERE id = ${topicId}
  `) as Array<{ starter_id: string; forum_id: string }>;

  return topic === undefined ? null : { starterId: topic.starter_id, forumId: topic.forum_id };
}

/**
 * Computes who should hear about an event. Authorisation is evaluated against current state,
 * not when the event happened: a recipient who can no longer read the content is dropped
 * silently (ADR 0011). The follow and digest tasks extend this list; today replies notify the
 * topic starter and promotions notify the promoted member.
 */
export async function eventRecipients(
  sql: SQL,
  event: StoredEvent,
): Promise<readonly NotificationRecipient[]> {
  switch (event.type) {
    case "post.created": {
      const postId = event.payloadIds.postId;
      const topicId = event.payloadIds.topicId;
      const authorId = event.payloadIds.authorId;

      if (postId === undefined || topicId === undefined || authorId === undefined) {
        return [];
      }

      const topic = await readTopic(sql, topicId);

      if (topic === null || topic.starterId === authorId) {
        return [];
      }

      const tree = await loadForumTree(sql);
      const mayRead = await can(sql, topic.starterId, "read", {
        forumId: topic.forumId,
        tree,
      });

      if (!mayRead) {
        return [];
      }

      return [
        {
          memberId: topic.starterId,
          type: "topic.reply",
          actorId: authorId,
          topicId,
          forumId: topic.forumId,
          postId,
        },
      ];
    }
    case "member.promoted": {
      const memberId = event.payloadIds.memberId;

      if (memberId === undefined) {
        return [];
      }

      const [member] = (await sql`
        SELECT id
        FROM core.members
        WHERE id = ${memberId} AND is_service = false
      `) as Array<{ id: string }>;

      if (member === undefined) {
        return [];
      }

      return [
        {
          memberId,
          type: "member.promoted",
          actorId: null,
          topicId: null,
          forumId: null,
          postId: null,
        },
      ];
    }
    // A new topic notifies forum followers; the follows task supplies that recipient list.
    case "topic.created":
      return [];
    default:
      return [];
  }
}

/** Notification kinds this change creates; the centre renders each with its own i18n key. */
export const NOTIFICATION_TYPES = ["topic.reply", "topic.created", "member.promoted"] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationWrite {
  readonly memberId: string;
  readonly type: NotificationType;
  readonly eventId: bigint;
  readonly actorId?: string | null;
  readonly topicId?: string | null;
  readonly forumId?: string | null;
  readonly postId?: string | null;
}

/**
 * Inserts one notification for one recipient. At-least-once event delivery can run the same
 * event twice; the `(event_id, member_id)` key makes the second insert a no-op (ADR 0011).
 * Returns null when the notification already existed.
 */
export async function createNotification(
  sql: SQL,
  input: NotificationWrite,
): Promise<bigint | null> {
  const rows = (await sql`
    INSERT INTO core.notifications (
      member_id, type, event_id, actor_id, topic_id, forum_id, post_id
    ) VALUES (
      ${input.memberId}, ${input.type}, ${input.eventId}, ${input.actorId ?? null},
      ${input.topicId ?? null}, ${input.forumId ?? null}, ${input.postId ?? null}
    )
    ON CONFLICT (event_id, member_id) DO NOTHING
    RETURNING id
  `) as Array<{ id: bigint | string }>;

  const row = rows[0];
  return row === undefined ? null : BigInt(row.id);
}
