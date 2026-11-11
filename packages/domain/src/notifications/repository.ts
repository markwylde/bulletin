import type { SQL } from "bun";
import type { StoredEvent } from "../events/outbox.ts";
import { can } from "../permissions/can.ts";
import type { ForumTree } from "../permissions/tree.ts";
import { loadForumTree } from "../permissions/tree-store.ts";

/** Notification kinds the subscriber creates; the centre renders each with its own i18n key. */
export const NOTIFICATION_TYPES = [
  "topic.reply",
  "topic.created",
  "post.mention",
  "post.quote",
  "member.promoted",
  "reaction.added",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationRecipient {
  readonly memberId: string;
  readonly type: NotificationType;
  readonly actorId: string | null;
  readonly topicId: string | null;
  readonly forumId: string | null;
  readonly postId: string | null;
}

/** Later changes (ignore list, member blocks) drop recipients through this extension point. */
export interface NotificationFilterContext {
  readonly sql: SQL;
  readonly event: StoredEvent;
  readonly recipient: NotificationRecipient;
}

export type NotificationRecipientFilter = (context: NotificationFilterContext) => Promise<boolean>;

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
 * Inserts or coalesces one notification for one recipient. `notification_events` is the
 * at-least-once dedupe key, so a retried event never increments a count twice; while a
 * notification is unread, further events of the same type in the same topic become one entry
 * with a count (ADR 0011, notifications spec).
 */
export async function createNotification(
  sql: SQL,
  input: NotificationWrite,
): Promise<bigint | null> {
  const claimed = (await sql`
    INSERT INTO core.notification_events (event_id, member_id)
    VALUES (${input.eventId}, ${input.memberId})
    ON CONFLICT DO NOTHING
    RETURNING 1
  `) as unknown[];

  if (claimed.length === 0) {
    return null;
  }

  const rows = (await (input.topicId === null || input.topicId === undefined
    ? sql`
        INSERT INTO core.notifications (
          member_id, type, event_id, actor_id, topic_id, forum_id, post_id
        ) VALUES (
          ${input.memberId}, ${input.type}, ${input.eventId}, ${input.actorId ?? null},
          NULL, ${input.forumId ?? null}, ${input.postId ?? null}
        )
        RETURNING id
      `
    : sql`
        INSERT INTO core.notifications (
          member_id, type, event_id, actor_id, topic_id, forum_id, post_id, count
        ) VALUES (
          ${input.memberId}, ${input.type}, ${input.eventId}, ${input.actorId ?? null},
          ${input.topicId}, ${input.forumId ?? null}, ${input.postId ?? null}, 1
        )
        ON CONFLICT (member_id, type, topic_id)
        WHERE read_at IS NULL AND topic_id IS NOT NULL
        DO UPDATE SET
          count = core.notifications.count + 1,
          event_id = EXCLUDED.event_id,
          actor_id = EXCLUDED.actor_id,
          forum_id = EXCLUDED.forum_id,
          post_id = EXCLUDED.post_id,
          updated_at = now()
        RETURNING id
      `)) as Array<{ id: bigint | string }>;

  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  const id = BigInt(row.id);
  await sql`
    UPDATE core.notification_events
    SET notification_id = ${id}
    WHERE event_id = ${input.eventId} AND member_id = ${input.memberId}
  `;

  return id;
}

interface PostContext {
  readonly topicId: string;
  readonly forumId: string;
  readonly authorId: string;
  readonly position: number;
}

async function readPost(sql: SQL, postId: string): Promise<PostContext | null> {
  const [row] = (await sql`
    SELECT p.topic_id::text AS topic_id, t.forum_id::text AS forum_id,
      p.author_id::text AS author_id, p.position
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ${postId}
  `) as Array<{
    topic_id: string;
    forum_id: string;
    author_id: string;
    position: number;
  }>;

  return row === undefined
    ? null
    : {
        topicId: row.topic_id,
        forumId: row.forum_id,
        authorId: row.author_id,
        position: row.position,
      };
}

async function topicStarter(sql: SQL, topicId: string): Promise<string | null> {
  const [row] = (await sql`
    SELECT starter_id::text AS starter_id FROM core.topics WHERE id = ${topicId}
  `) as Array<{ starter_id: string | null }>;
  return row?.starter_id ?? null;
}

async function topicFollowers(sql: SQL, topicId: string): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT member_id::text AS id FROM core.followed_topics WHERE topic_id = ${topicId}
  `) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** Forum followers also hear about new topics in subforums of the followed forum. */
async function forumFollowers(sql: SQL, forumId: string): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT DISTINCT ff.member_id::text AS id
    FROM core.followed_forums ff
    JOIN core.forums followed ON followed.id = ff.forum_id
    JOIN core.forums target ON target.id = ${forumId}
    WHERE target.path <@ followed.path
  `) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function memberFollowers(sql: SQL, memberId: string): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT follower_id::text AS id FROM core.followed_members WHERE followed_id = ${memberId}
  `) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function mentionedMembers(sql: SQL, postId: string): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT unnest(mentioned_member_ids)::text AS id FROM core.posts WHERE id = ${postId}
  `) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function quotedPostAuthors(sql: SQL, postId: string): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT DISTINCT quoted.author_id::text AS id
    FROM core.posts source
    CROSS JOIN LATERAL unnest(source.quoted_post_ids) AS quoted_id
    JOIN core.posts quoted ON quoted.id = quoted_id
    WHERE source.id = ${postId}
  `) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * Computes who should hear about an event. Authorisation is evaluated against current state,
 * not when the event happened: a recipient who can no longer read the content is dropped
 * silently (ADR 0011). A member mentioned or quoted gets that notification instead of the
 * generic reply one, and every member appears at most once per event.
 */
export async function eventRecipients(
  sql: SQL,
  event: StoredEvent,
): Promise<readonly NotificationRecipient[]> {
  const candidates = new Map<string, NotificationRecipient>();
  const rank: Record<NotificationType, number> = {
    "post.mention": 5,
    "post.quote": 4,
    "topic.reply": 3,
    "topic.created": 2,
    "member.promoted": 1,
    "reaction.added": 0,
  };
  let tree: ForumTree | null = null;

  const add = (recipient: NotificationRecipient): void => {
    const existing = candidates.get(recipient.memberId);

    if (existing === undefined || rank[recipient.type] > rank[existing.type]) {
      candidates.set(recipient.memberId, recipient);
    }
  };

  const readable = async (memberId: string, forumId: string): Promise<boolean> => {
    tree ??= await loadForumTree(sql);
    return can(sql, memberId, "read", { forumId, tree });
  };

  switch (event.type) {
    case "post.created": {
      const postId = event.payloadIds.postId;

      if (postId === undefined) {
        return [];
      }

      const post = await readPost(sql, postId);

      if (post === null) {
        return [];
      }

      const starter = await topicStarter(sql, post.topicId);
      const base = {
        actorId: post.authorId,
        topicId: post.topicId,
        forumId: post.forumId,
        postId,
      } as const;

      if (post.position > 1 && starter !== null && starter !== post.authorId) {
        add({ ...base, memberId: starter, type: "topic.reply" });
      }

      if (post.position > 1) {
        for (const follower of await topicFollowers(sql, post.topicId)) {
          add({ ...base, memberId: follower, type: "topic.reply" });
        }

        for (const follower of await memberFollowers(sql, post.authorId)) {
          add({ ...base, memberId: follower, type: "topic.reply" });
        }
      }

      for (const memberId of await mentionedMembers(sql, postId)) {
        add({ ...base, memberId, type: "post.mention" });
      }

      for (const memberId of await quotedPostAuthors(sql, postId)) {
        add({ ...base, memberId, type: "post.quote" });
      }

      candidates.delete(post.authorId);

      const recipients: NotificationRecipient[] = [];

      for (const recipient of candidates.values()) {
        if (await readable(recipient.memberId, post.forumId)) {
          recipients.push(recipient);
        }
      }

      return recipients;
    }
    case "topic.created": {
      const topicId = event.payloadIds.topicId;
      const forumId = event.payloadIds.forumId;
      const authorId = event.payloadIds.authorId;
      const postId = event.payloadIds.postId;

      if (topicId === undefined || forumId === undefined || authorId === undefined) {
        return [];
      }

      const base = {
        actorId: authorId,
        topicId,
        forumId,
        postId: postId ?? null,
      } as const;

      for (const follower of await forumFollowers(sql, forumId)) {
        add({ ...base, memberId: follower, type: "topic.created" });
      }

      for (const follower of await memberFollowers(sql, authorId)) {
        add({ ...base, memberId: follower, type: "topic.created" });
      }

      candidates.delete(authorId);

      const recipients: NotificationRecipient[] = [];

      for (const recipient of candidates.values()) {
        if (await readable(recipient.memberId, forumId)) {
          recipients.push(recipient);
        }
      }

      return recipients;
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

      return member === undefined
        ? []
        : [
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
    default:
      return [];
  }
}
