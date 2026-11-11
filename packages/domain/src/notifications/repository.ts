import type { SQL } from "bun";
import { loadEvent, type StoredEvent } from "../events/outbox.ts";
import { can } from "../permissions/can.ts";
import { loadPermissionSnapshot, type PermissionSnapshot } from "../permissions/snapshot.ts";
import type { ForumTree } from "../permissions/tree.ts";
import { loadForumTree } from "../permissions/tree-store.ts";
import { listIgnoredIds } from "../relationships/repository.ts";
import { isNotificationTypeValue, notificationPreferenceMatrix } from "./preferences.ts";

/** Notification kinds the subscriber creates; the centre renders each with its own i18n key. */
export const NOTIFICATION_TYPES = [
  "topic.reply",
  "topic.created",
  "post.mention",
  "post.quote",
  "member.promoted",
  "reaction.added",
  "reputation.given",
  "friend.accepted",
  "badge.awarded",
  "conversation.message",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationRecipientSource =
  | "follow"
  | "mention"
  | "quote"
  | "promotion"
  | "reaction"
  | "reputation"
  | "friend"
  | "badge"
  | "conversation";

/** These types are about one post, so an unread entry coalesces per post, not per topic. */
const POST_COALESCED_TYPES = ["reaction.added", "reputation.given"] as const;

function isPostCoalesced(type: NotificationType): boolean {
  return (POST_COALESCED_TYPES as readonly string[]).includes(type);
}

export interface NotificationRecipient {
  readonly memberId: string;
  readonly type: NotificationType;
  /** Follow-derived recipients are hidden when the `follows` flag is off. */
  readonly source: NotificationRecipientSource;
  readonly actorId: string | null;
  /** Counts towards the distinct-contributor total even when the actor stays anonymous. */
  readonly contributorId?: string | null;
  readonly topicId: string | null;
  readonly forumId: string | null;
  readonly postId: string | null;
  readonly conversationId?: string | null;
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
  readonly contributorId?: string | null;
  readonly topicId?: string | null;
  readonly forumId?: string | null;
  readonly postId?: string | null;
  readonly conversationId?: string | null;
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

  if (isPostCoalesced(input.type) && (input.postId === null || input.postId === undefined)) {
    throw new Error(`A ${input.type} notification needs a post`);
  }

  const conversationId = input.conversationId ?? null;

  if (input.type === "conversation.message" && conversationId === null) {
    throw new Error("A conversation.message notification needs a conversation");
  }

  const rows = (await (conversationId !== null
    ? sql`
        INSERT INTO core.notifications (
          member_id, type, event_id, actor_id, conversation_id, count
        ) VALUES (
          ${input.memberId}, ${input.type}, ${input.eventId}, ${input.actorId ?? null},
          ${conversationId}, 1
        )
        ON CONFLICT (member_id, type, conversation_id)
        WHERE read_at IS NULL
          AND conversation_id IS NOT NULL
          AND type = 'conversation.message'
        DO UPDATE SET
          count = core.notifications.count + 1,
          event_id = EXCLUDED.event_id,
          actor_id = EXCLUDED.actor_id,
          updated_at = now()
        RETURNING id
      `
    : isPostCoalesced(input.type)
      ? sql`
        INSERT INTO core.notifications (
          member_id, type, event_id, actor_id, topic_id, forum_id, post_id, count
        ) VALUES (
          ${input.memberId}, ${input.type}, ${input.eventId}, ${input.actorId ?? null},
          ${input.topicId ?? null}, ${input.forumId ?? null}, ${input.postId ?? null}, 1
        )
        ON CONFLICT (member_id, type, post_id)
        WHERE read_at IS NULL AND post_id IS NOT NULL
          AND type IN ('reaction.added', 'reputation.given')
        DO UPDATE SET
          count = core.notifications.count + 1,
          event_id = EXCLUDED.event_id,
          actor_id = EXCLUDED.actor_id,
          topic_id = EXCLUDED.topic_id,
          forum_id = EXCLUDED.forum_id,
          updated_at = now()
        RETURNING id
      `
      : input.topicId === null || input.topicId === undefined
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
          AND type NOT IN ('reaction.added', 'reputation.given')
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

  if (isPostCoalesced(input.type)) {
    const contributor = input.contributorId ?? input.actorId ?? null;

    if (contributor !== null) {
      await sql`
        INSERT INTO core.notification_actors (notification_id, actor_id)
        VALUES (${id}, ${contributor})
        ON CONFLICT DO NOTHING
      `;
    }

    // One notification counts people, not events: a member switching reactions stays one.
    await sql`
      UPDATE core.notifications n
      SET count = GREATEST(
        1,
        (SELECT count(*)::int FROM core.notification_actors a WHERE a.notification_id = n.id)
      )
      WHERE n.id = ${id}
    `;
  }

  await sql`
    UPDATE core.notification_events
    SET notification_id = ${id}
    WHERE event_id = ${input.eventId} AND member_id = ${input.memberId}
  `;
  // Wake that member's open streams; the count itself is read from durable state (ADR 0003).
  await sql`SELECT pg_notify('notify_member', ${input.memberId})`;

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
    WHERE p.id = ${postId} AND p.visibility = 'visible'
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
    "conversation.message": 6,
    "post.mention": 5,
    "post.quote": 4,
    "topic.reply": 3,
    "topic.created": 2,
    "member.promoted": 1,
    "friend.accepted": 1,
    "badge.awarded": 1,
    "reaction.added": 0,
    "reputation.given": 0,
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
    case "pm.sent": {
      const conversationId = event.payloadIds.conversationId;
      const senderId = event.payloadIds.senderId;

      if (conversationId === undefined || senderId === undefined) {
        return [];
      }

      const rows = (await sql`
        SELECT p.member_id::text AS member_id
        FROM core.conversation_participants p
        WHERE p.conversation_id = ${conversationId}
          AND p.state = 'active'
          AND p.member_id <> ${senderId}
        ORDER BY p.member_id
      `) as Array<{ member_id: string }>;

      return rows.map((row) => ({
        memberId: row.member_id,
        type: "conversation.message" as const,
        source: "conversation" as const,
        actorId: senderId.toString(),
        topicId: null,
        forumId: null,
        postId: null,
        conversationId: conversationId.toString(),
      }));
    }
    case "post.created": {
      const postId = event.payloadIds.postId;

      if (postId === undefined) {
        return [];
      }

      const post = await readPost(sql, postId);

      if (post === null) {
        return [];
      }

      const base = {
        actorId: post.authorId,
        topicId: post.topicId,
        forumId: post.forumId,
        postId,
      } as const;

      if (post.position > 1) {
        for (const follower of await topicFollowers(sql, post.topicId)) {
          add({ ...base, memberId: follower, type: "topic.reply", source: "follow" });
        }

        for (const follower of await memberFollowers(sql, post.authorId)) {
          add({ ...base, memberId: follower, type: "topic.reply", source: "follow" });
        }
      }

      for (const memberId of await mentionedMembers(sql, postId)) {
        add({ ...base, memberId, type: "post.mention", source: "mention" });
      }

      for (const memberId of await quotedPostAuthors(sql, postId)) {
        add({ ...base, memberId, type: "post.quote", source: "quote" });
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

      const firstPost = postId === undefined ? null : await readPost(sql, postId);

      if (firstPost === null) {
        return [];
      }

      const base = {
        actorId: authorId,
        topicId,
        forumId: firstPost.forumId,
        postId: postId ?? null,
      } as const;

      for (const follower of await forumFollowers(sql, forumId)) {
        add({ ...base, memberId: follower, type: "topic.created", source: "follow" });
      }

      for (const follower of await memberFollowers(sql, authorId)) {
        add({ ...base, memberId: follower, type: "topic.created", source: "follow" });
      }

      candidates.delete(authorId);

      const recipients: NotificationRecipient[] = [];

      for (const recipient of candidates.values()) {
        if (await readable(recipient.memberId, firstPost.forumId)) {
          recipients.push(recipient);
        }
      }

      return recipients;
    }
    case "reaction.added": {
      const postId = event.payloadIds.postId;
      const giverId = event.payloadIds.memberId;

      if (postId === undefined || giverId === undefined) {
        return [];
      }

      const post = await readPost(sql, postId);

      if (post === null || post.authorId === giverId) {
        return [];
      }

      // Authorisation is rechecked now: a topic moved somewhere unreadable stops the notice.
      if (!(await readable(post.authorId, post.forumId))) {
        return [];
      }

      return [
        {
          memberId: post.authorId,
          type: "reaction.added",
          source: "reaction",
          actorId: giverId,
          topicId: post.topicId,
          forumId: post.forumId,
          postId,
        },
      ];
    }
    case "reputation.given": {
      const postId = event.payloadIds.postId;
      const giverId = event.payloadIds.giverId;
      const receiverId = event.payloadIds.receiverId;

      if (postId === undefined || giverId === undefined || receiverId === undefined) {
        return [];
      }

      if (receiverId === giverId) {
        return [];
      }

      const post = await readPost(sql, postId);

      if (post === null || post.authorId !== receiverId) {
        return [];
      }

      if (!(await readable(receiverId, post.forumId))) {
        return [];
      }

      // Givers are visible to staff only (ADR 0012): the recipient never learns who gave.
      return [
        {
          memberId: receiverId,
          type: "reputation.given",
          source: "reputation",
          actorId: null,
          contributorId: giverId,
          topicId: post.topicId,
          forumId: post.forumId,
          postId,
        },
      ];
    }
    case "friend.accepted": {
      const requesterId = event.payloadIds.requesterId;
      const accepterId = event.payloadIds.accepterId;

      if (requesterId === undefined || accepterId === undefined || requesterId === accepterId) {
        return [];
      }

      return [
        {
          memberId: requesterId,
          type: "friend.accepted",
          source: "friend",
          actorId: accepterId,
          topicId: null,
          forumId: null,
          postId: null,
        },
      ];
    }
    case "badge.awarded": {
      const memberId = event.payloadIds.memberId;
      const badgeId = event.payloadIds.badgeId;

      if (memberId === undefined || badgeId === undefined) {
        return [];
      }

      return [
        {
          memberId,
          type: "badge.awarded",
          source: "badge",
          actorId: null,
          topicId: null,
          forumId: null,
          postId: null,
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
        WHERE id = ${memberId} AND is_service = false AND state = 'active'
      `) as Array<{ id: string }>;

      return member === undefined
        ? []
        : [
            {
              memberId,
              type: "member.promoted",
              source: "promotion",
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

export interface NotificationEntry {
  readonly id: string;
  readonly type: NotificationType;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly topicId: string | null;
  readonly topicTitle: string | null;
  readonly topicSlug: string | null;
  readonly postId: string | null;
  readonly conversationId: string | null;
  readonly conversationTitle: string | null;
  readonly count: number;
  readonly read: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface NotificationListRow {
  readonly id: string;
  readonly type: string;
  readonly actor_id: string | null;
  readonly actor_name: string | null;
  readonly topic_id: string | null;
  readonly topic_title: string | null;
  readonly topic_slug: string | null;
  readonly forum_id: string | null;
  readonly post_id: string | null;
  readonly conversation_id: string | null;
  readonly conversation_title: string | null;
  readonly count: number;
  readonly read_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

/**
 * The member's notifications, newest first. Entries whose content the member can no longer read
 * are omitted: a notification never reveals a topic title after access is lost (notifications
 * spec, ADR 0006). `limit` and `offset` count *visible* entries: batches are read until a full
 * page is collected or the table ends, so one inaccessible row can never end paging early.
 */
export async function listNotifications(
  sql: SQL,
  memberId: string,
  options: {
    readonly limit?: number;
    readonly offset?: number;
    readonly tree?: ForumTree;
    readonly snapshot?: PermissionSnapshot;
  } = {},
): Promise<readonly NotificationEntry[]> {
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const batchSize = Math.max(limit, 50);
  const tree = options.tree ?? (await loadForumTree(sql));
  const snapshot =
    options.snapshot ?? (await loadPermissionSnapshot(sql, memberId, { tree, sessionId: null }));
  const forumAccess = new Map<string, boolean>();
  const entries: NotificationEntry[] = [];
  let rawOffset = 0;
  let skipped = 0;
  let hasRows = true;

  while (hasRows && entries.length < limit) {
    const rows = (await sql`
      SELECT
        n.id::text AS id,
        n.type,
        n.actor_id::text AS actor_id,
        a.display_name AS actor_name,
        n.topic_id::text AS topic_id,
        t.title AS topic_title,
        t.slug AS topic_slug,
        t.forum_id::text AS forum_id,
        n.post_id::text AS post_id,
        n.conversation_id::text AS conversation_id,
        c.title AS conversation_title,
        n.count,
        n.read_at,
        n.created_at,
        n.updated_at
      FROM core.notifications n
      LEFT JOIN core.members a ON a.id = n.actor_id
      LEFT JOIN core.topics t ON t.id = n.topic_id
      LEFT JOIN core.posts p ON p.id = n.post_id
      LEFT JOIN core.conversations c ON c.id = n.conversation_id
      WHERE n.member_id = ${memberId}
        AND (n.post_id IS NULL OR p.visibility = 'visible')
        AND (n.topic_id IS NULL OR t.id IS NOT NULL)
        AND (
          n.conversation_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM core.conversation_participants cp
            WHERE cp.conversation_id = n.conversation_id
              AND cp.member_id = n.member_id
              AND cp.state = 'active'
          )
        )
        AND coalesce((
          SELECT p.enabled FROM core.notification_preferences p
          WHERE p.member_id = n.member_id AND p.type = n.type AND p.channel = 'in_app'
        ), true)
      ORDER BY n.updated_at DESC, n.id DESC
      LIMIT ${batchSize} OFFSET ${rawOffset}
    `) as NotificationListRow[];

    rawOffset += rows.length;
    hasRows = rows.length === batchSize;

    for (const row of rows) {
      if (row.forum_id !== null) {
        let readable = forumAccess.get(row.forum_id);

        if (readable === undefined) {
          readable = await can(sql, memberId, "read", {
            forumId: row.forum_id,
            tree,
            snapshot,
          });
          forumAccess.set(row.forum_id, readable);
        }

        if (!readable) {
          continue;
        }
      }

      if (skipped < offset) {
        skipped += 1;
        continue;
      }

      entries.push({
        id: row.id,
        type: row.type as NotificationType,
        actorId: row.actor_id,
        actorName: row.actor_name,
        topicId: row.topic_id,
        topicTitle: row.topic_title,
        topicSlug: row.topic_slug,
        postId: row.post_id,
        conversationId: row.conversation_id,
        conversationTitle: row.conversation_title,
        count: row.count,
        read: row.read_at !== null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      });

      if (entries.length >= limit) {
        break;
      }
    }
  }

  return entries;
}

/**
 * Unread entries that the member can still read. Grouped by forum so one capability check per
 * distinct forum covers the count used by the bell.
 */
export async function unreadNotificationCount(
  sql: SQL,
  memberId: string,
  options: { readonly tree?: ForumTree; readonly snapshot?: PermissionSnapshot } = {},
): Promise<number> {
  const rows = (await sql`
    SELECT t.forum_id::text AS forum_id, count(*)::int AS count
    FROM core.notifications n
    LEFT JOIN core.topics t ON t.id = n.topic_id
    LEFT JOIN core.posts p ON p.id = n.post_id
    WHERE n.member_id = ${memberId}
      AND n.read_at IS NULL
      AND (n.post_id IS NULL OR p.visibility = 'visible')
      AND (n.topic_id IS NULL OR t.id IS NOT NULL)
      AND (
        n.conversation_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM core.conversation_participants cp
          WHERE cp.conversation_id = n.conversation_id
            AND cp.member_id = n.member_id
            AND cp.state = 'active'
        )
      )
      AND coalesce((
        SELECT pref.enabled FROM core.notification_preferences pref
        WHERE pref.member_id = n.member_id AND pref.type = n.type AND pref.channel = 'in_app'
      ), true)
    GROUP BY t.forum_id
  `) as Array<{ forum_id: string | null; count: number }>;

  if (rows.length === 0) {
    return 0;
  }

  const tree = options.tree ?? (await loadForumTree(sql));
  const snapshot =
    options.snapshot ?? (await loadPermissionSnapshot(sql, memberId, { tree, sessionId: null }));
  let total = 0;

  for (const row of rows) {
    if (
      row.forum_id === null ||
      (await can(sql, memberId, "read", { forumId: row.forum_id, tree, snapshot }))
    ) {
      total += row.count;
    }
  }

  return total;
}

export async function markNotificationRead(
  sql: SQL,
  memberId: string,
  id: string,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE core.notifications
    SET read_at = now(), updated_at = now()
    WHERE id = ${id} AND member_id = ${memberId} AND read_at IS NULL
    RETURNING 1
  `) as unknown[];
  return rows.length > 0;
}

export async function markAllNotificationsRead(sql: SQL, memberId: string): Promise<number> {
  const rows = (await sql`
    UPDATE core.notifications
    SET read_at = now(), updated_at = now()
    WHERE member_id = ${memberId} AND read_at IS NULL
    RETURNING 1
  `) as unknown[];
  return rows.length;
}

/** The notification a retried event already produced, so its email intent can be re-enqueued. */
export async function notificationIdForEvent(
  sql: SQL,
  eventId: bigint,
  memberId: string,
): Promise<bigint | null> {
  const [row] = (await sql`
    SELECT notification_id
    FROM core.notification_events
    WHERE event_id = ${eventId} AND member_id = ${memberId}
  `) as Array<{ notification_id: bigint | string | null }>;

  return row?.notification_id === null || row?.notification_id === undefined
    ? null
    : BigInt(row.notification_id);
}

export interface DigestItem {
  readonly kind:
    | "topic"
    | "reply"
    | "mention"
    | "quote"
    | "promotion"
    | "reaction"
    | "reputation"
    | "conversation";
  readonly conversationId?: string | null;
  readonly topicId: string | null;
  readonly title: string;
  readonly slug: string | null;
  readonly forumId: string | null;
  readonly postId: string | null;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly createdAt: Date;
}

interface DigestRow {
  readonly topic_id: string;
  readonly title: string;
  readonly slug: string;
  readonly forum_id: string;
  readonly post_id: string | null;
  readonly actor_id: string | null;
  readonly actor_name: string | null;
  readonly created_at: Date | string;
}

interface DigestNotificationRow {
  readonly id: string;
  readonly type_from_notification: string;
  readonly created_at: Date | string;
  readonly actor_id: string | null;
  readonly topic_id: string | null;
  readonly title: string | null;
  readonly slug: string | null;
  readonly forum_id: string | null;
  readonly conversation_id: string | null;
  readonly conversation_title: string | null;
  readonly actor_name: string | null;
}

const DIGEST_TYPE_BY_KIND = {
  topic: "topic.created",
  reply: "topic.reply",
  mention: "post.mention",
  quote: "post.quote",
  promotion: "member.promoted",
  reaction: "reaction.added",
  reputation: "reputation.given",
  conversation: "conversation.message",
} as const;

/**
 * New activity since the window in followed topics and forums, mentions, quotes of the member's
 * posts and notification-backed types (promotions and reactions), with `can()` at build time.
 * Only types whose digest channel is enabled are included (default off). One entry per topic:
 * a mention wins over a quote, which wins over a reply, which wins over a new-topic row.
 */
export async function digestItems(
  sql: SQL,
  memberId: string,
  options: {
    readonly since: Date;
    readonly until?: Date;
    readonly limit?: number;
    readonly tree?: ForumTree;
    readonly snapshot?: PermissionSnapshot;
  },
): Promise<readonly DigestItem[]> {
  const until = options.until ?? new Date();
  const tree = options.tree ?? (await loadForumTree(sql));
  const snapshot =
    options.snapshot ?? (await loadPermissionSnapshot(sql, memberId, { tree, sessionId: null }));
  const preferences = await notificationPreferenceMatrix(sql, memberId);
  const [replies, topics, memberActivity, mentions, quotes, notificationRows] = (await Promise.all([
    sql`
      SELECT DISTINCT ON (t.id)
        t.id::text AS topic_id, t.title, t.slug, t.forum_id::text AS forum_id,
        p.id::text AS post_id, p.author_id::text AS actor_id, a.display_name AS actor_name, p.created_at
      FROM core.followed_topics ft
      JOIN core.topics t ON t.id = ft.topic_id
      JOIN core.posts p ON p.topic_id = t.id
        AND p.visibility = 'visible'
        AND p.created_at > ${options.since}
        AND p.created_at <= ${until}
      LEFT JOIN core.members a ON a.id = p.author_id
      WHERE ft.member_id = ${memberId}
      ORDER BY t.id, p.created_at DESC
    `,
    sql`
      SELECT DISTINCT ON (t.id)
        t.id::text AS topic_id, t.title, t.slug, t.forum_id::text AS forum_id,
        t.first_post_id::text AS post_id, t.starter_id::text AS actor_id, a.display_name AS actor_name, t.created_at
      FROM core.followed_forums ff
      JOIN core.forums followed ON followed.id = ff.forum_id
      JOIN core.forums target ON target.path <@ followed.path
      JOIN core.topics t ON t.forum_id = target.id
        AND t.created_at > ${options.since}
        AND t.created_at <= ${until}
      JOIN core.posts first_post ON first_post.id = t.first_post_id
        AND first_post.visibility = 'visible'
      LEFT JOIN core.members a ON a.id = t.starter_id
      WHERE ff.member_id = ${memberId}
      ORDER BY t.id, t.created_at DESC
    `,
    // A followed member's new activity, whether or not the follower also follows the forum.
    sql`
      SELECT DISTINCT ON (t.id)
        t.id::text AS topic_id, t.title, t.slug, t.forum_id::text AS forum_id,
        p.id::text AS post_id, p.author_id::text AS actor_id, a.display_name AS actor_name, p.created_at
      FROM core.followed_members fm
      JOIN core.posts p ON p.author_id = fm.followed_id
        AND p.visibility = 'visible'
        AND p.created_at > ${options.since}
        AND p.created_at <= ${until}
      JOIN core.topics t ON t.id = p.topic_id
      LEFT JOIN core.members a ON a.id = p.author_id
      WHERE fm.follower_id = ${memberId}
      ORDER BY t.id, p.created_at DESC
    `,
    sql`
      SELECT DISTINCT ON (t.id)
        t.id::text AS topic_id, t.title, t.slug, t.forum_id::text AS forum_id,
        p.id::text AS post_id, p.author_id::text AS actor_id, a.display_name AS actor_name, p.created_at
      FROM core.posts p
      JOIN core.members m ON m.id = ${memberId}
      JOIN core.topics t ON t.id = p.topic_id
      LEFT JOIN core.members a ON a.id = p.author_id
      WHERE m.id = ANY(p.mentioned_member_ids)
        AND p.visibility = 'visible'
        AND p.created_at > ${options.since}
        AND p.created_at <= ${until}
      ORDER BY t.id, p.created_at DESC
    `,
    sql`
      SELECT DISTINCT ON (t.id)
        t.id::text AS topic_id, t.title, t.slug, t.forum_id::text AS forum_id,
        p.id::text AS post_id, p.author_id::text AS actor_id, a.display_name AS actor_name, p.created_at
      FROM core.posts p
      JOIN core.topics t ON t.id = p.topic_id
      LEFT JOIN core.members a ON a.id = p.author_id
      WHERE p.visibility = 'visible'
        AND p.created_at > ${options.since}
        AND p.created_at <= ${until}
        AND EXISTS (
          SELECT 1 FROM core.posts quoted
          WHERE quoted.id = ANY(p.quoted_post_ids) AND quoted.author_id = ${memberId}
        )
      ORDER BY t.id, p.created_at DESC
    `,
    sql`
      SELECT
        n.id::text AS id,
        n.type AS type_from_notification,
        n.created_at,
        n.actor_id::text AS actor_id,
        t.id::text AS topic_id,
        t.title,
        t.slug,
        t.forum_id::text AS forum_id,
        n.conversation_id::text AS conversation_id,
        c.title AS conversation_title,
        a.display_name AS actor_name
      FROM core.notifications n
      LEFT JOIN core.topics t ON t.id = n.topic_id
      LEFT JOIN core.conversations c ON c.id = n.conversation_id
      LEFT JOIN core.members a ON a.id = n.actor_id
      WHERE n.member_id = ${memberId}
        AND n.type IN (
          'member.promoted', 'reaction.added', 'reputation.given', 'conversation.message'
        )
        AND (
          n.conversation_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM core.conversation_participants cp
            WHERE cp.conversation_id = n.conversation_id
              AND cp.member_id = n.member_id
              AND cp.state = 'active'
          )
        )
        AND n.created_at > ${options.since}
        AND n.created_at <= ${until}
      ORDER BY n.created_at DESC
    `,
  ])) as [DigestRow[], DigestRow[], DigestRow[], DigestRow[], DigestRow[], DigestNotificationRow[]];
  const byTopic = new Map<string, DigestItem>();
  const rank = {
    topic: 1,
    reaction: 2,
    reputation: 2,
    reply: 3,
    quote: 4,
    mention: 5,
    promotion: 6,
    conversation: 7,
  } as const;

  for (const [kind, rows] of [
    ["topic", topics],
    ["reply", replies],
    ["reply", memberActivity],
    ["mention", mentions],
    ["quote", quotes],
  ] as const) {
    if (preferences[DIGEST_TYPE_BY_KIND[kind]].digest !== true) {
      continue;
    }

    for (const row of rows) {
      const existing = byTopic.get(row.topic_id);

      if (existing !== undefined && rank[existing.kind] >= rank[kind]) {
        continue;
      }

      byTopic.set(row.topic_id, {
        kind,
        topicId: row.topic_id,
        title: row.title,
        slug: row.slug,
        forumId: row.forum_id,
        postId: row.post_id,
        actorId: row.actor_id,
        actorName: row.actor_name,
        createdAt: new Date(row.created_at),
      });
    }
  }

  for (const row of notificationRows) {
    if (!isNotificationTypeValue(row.type_from_notification)) {
      continue;
    }

    const kind =
      row.type_from_notification === "member.promoted"
        ? "promotion"
        : row.type_from_notification === "reputation.given"
          ? "reputation"
          : row.type_from_notification === "conversation.message"
            ? "conversation"
            : "reaction";

    if (preferences[DIGEST_TYPE_BY_KIND[kind]].digest !== true) {
      continue;
    }

    const key =
      kind === "promotion"
        ? `promotion:${row.id}`
        : kind === "conversation"
          ? `conversation:${row.conversation_id ?? row.id}`
          : kind === "reputation"
            ? (row.topic_id ?? `reputation:${row.id}`)
            : (row.topic_id ?? `reaction:${row.id}`);
    const existing = byTopic.get(key);

    if (existing !== undefined && rank[existing.kind] >= rank[kind]) {
      continue;
    }

    byTopic.set(key, {
      kind,
      conversationId: row.conversation_id,
      topicId: row.topic_id,
      title: kind === "conversation" ? (row.conversation_title ?? "") : (row.title ?? ""),
      slug: row.slug,
      forumId: row.forum_id,
      postId: null,
      actorId: row.actor_id,
      actorName: row.actor_name,
      createdAt: new Date(row.created_at),
    });
  }

  const readable: DigestItem[] = [];
  const ignored = new Set(await listIgnoredIds(sql, memberId));

  for (const item of byTopic.values()) {
    if (item.actorId !== null && ignored.has(item.actorId)) {
      continue;
    }

    if (
      item.forumId !== null &&
      !(await can(sql, memberId, "read", { forumId: item.forumId, tree, snapshot }))
    ) {
      continue;
    }

    readable.push(item);
  }

  return readable
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, options.limit ?? 20);
}

export interface NotificationEmailContext {
  readonly memberId: string;
  readonly locale: string | null;
  readonly recipientName: string | null;
  readonly type: NotificationType;
  readonly actorName: string | null;
  readonly topicId: string | null;
  readonly topicTitle: string | null;
  readonly topicSlug: string | null;
  readonly postId: string | null;
  readonly conversationId: string | null;
  readonly conversationTitle: string | null;
}

/**
 * The context the email job needs, or null when the intent is delivered or the referenced topic
 * is no longer readable by the recipient (authorisation at delivery, ADR 0011).
 */
export async function notificationEmailContext(
  sql: SQL,
  intentId: string,
): Promise<NotificationEmailContext | null> {
  const [base] = (await sql`
    SELECT
      i.member_id::text AS member_id,
      m.locale,
      m.display_name AS recipient_name,
      n.type,
      i.source_event_id::text AS source_event_id,
      n.actor_id::text AS actor_id,
      n.topic_id::text AS topic_id,
      n.post_id::text AS post_id
    FROM core.delivery_intents i
    JOIN core.notifications n ON n.id = i.ref_id AND n.member_id = i.member_id
    JOIN core.members m ON m.id = i.member_id
    WHERE i.id = ${intentId}
      AND i.kind = 'notification'
      AND i.channel = 'email'
      AND i.delivered_at IS NULL
  `) as Array<{
    member_id: string;
    locale: string | null;
    recipient_name: string | null;
    type: string;
    source_event_id: string | null;
    actor_id: string | null;
    topic_id: string | null;
    post_id: string | null;
  }>;

  if (base === undefined || !isNotificationTypeValue(base.type)) {
    return null;
  }

  // The coalesced notification row points at the latest reply; the email must describe the
  // event that created this intent, with current visibility and permission checks.
  if (base.source_event_id !== null) {
    const event = await loadEvent(sql, BigInt(base.source_event_id));

    if (event !== null && (event.type === "post.created" || event.type === "topic.created")) {
      const postId = event.payloadIds.postId;

      if (postId === undefined) {
        return null;
      }

      const [post] = (await sql`
        SELECT
          p.id::text AS post_id,
          p.visibility,
          t.id::text AS topic_id,
          t.title,
          t.slug,
          t.forum_id::text AS forum_id,
          a.display_name AS actor_name
        FROM core.posts p
        JOIN core.topics t ON t.id = p.topic_id
        LEFT JOIN core.members a ON a.id = p.author_id
        WHERE p.id = ${postId}
      `) as Array<{
        post_id: string;
        visibility: string;
        topic_id: string;
        title: string;
        slug: string;
        forum_id: string;
        actor_name: string | null;
      }>;

      if (post === undefined || post.visibility !== "visible") {
        return null;
      }

      const tree = await loadForumTree(sql);
      const snapshot = await loadPermissionSnapshot(sql, base.member_id, {
        tree,
        sessionId: null,
      });

      if (
        !(await can(sql, base.member_id, "read", {
          forumId: post.forum_id,
          tree,
          snapshot,
        }))
      ) {
        return null;
      }

      return {
        memberId: base.member_id,
        locale: base.locale,
        recipientName: base.recipient_name,
        type: base.type,
        actorName: post.actor_name,
        topicId: post.topic_id,
        topicTitle: post.title,
        topicSlug: post.slug,
        postId: post.post_id,
        conversationId: null,
        conversationTitle: null,
      };
    }
  }

  // Notification types without content (promotions) and legacy intents without a source event.
  const rows = (await sql`
    SELECT
      a.display_name AS actor_name,
      t.forum_id::text AS forum_id,
      n.topic_id::text AS topic_id,
      t.title AS topic_title,
      t.slug AS topic_slug,
      n.post_id::text AS post_id,
      n.conversation_id::text AS conversation_id,
      c.title AS conversation_title
    FROM core.notifications n
    JOIN core.delivery_intents i ON i.id = ${intentId} AND i.ref_id = n.id
    LEFT JOIN core.members a ON a.id = n.actor_id
    LEFT JOIN core.topics t ON t.id = n.topic_id
    LEFT JOIN core.posts p ON p.id = n.post_id
    LEFT JOIN core.conversations c ON c.id = n.conversation_id
    WHERE n.member_id = ${base.member_id}
      AND (n.post_id IS NULL OR p.visibility = 'visible')
      AND (n.topic_id IS NULL OR t.id IS NOT NULL)
      AND (
        n.conversation_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM core.conversation_participants cp
          WHERE cp.conversation_id = n.conversation_id
            AND cp.member_id = n.member_id
            AND cp.state = 'active'
        )
      )
  `) as Array<{
    actor_name: string | null;
    forum_id: string | null;
    topic_id: string | null;
    topic_title: string | null;
    topic_slug: string | null;
    post_id: string | null;
    conversation_id: string | null;
    conversation_title: string | null;
  }>;

  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  if (row.forum_id !== null) {
    const tree = await loadForumTree(sql);
    const snapshot = await loadPermissionSnapshot(sql, base.member_id, { tree, sessionId: null });

    if (
      !(await can(sql, base.member_id, "read", {
        forumId: row.forum_id,
        tree,
        snapshot,
      }))
    ) {
      return null;
    }
  }

  return {
    memberId: base.member_id,
    locale: base.locale,
    recipientName: base.recipient_name,
    type: base.type,
    actorName: row.actor_name,
    topicId: row.topic_id,
    topicTitle: row.topic_title,
    topicSlug: row.topic_slug,
    postId: row.post_id,
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
  };
}

/** Latest durable notification id for a member (stream cursor). */
export async function maxNotificationId(sql: SQL, memberId: string): Promise<bigint> {
  const [row] = (await sql`
    SELECT coalesce(max(id), 0)::text AS id
    FROM core.notifications
    WHERE member_id = ${memberId}
  `) as Array<{ id: string }>;

  return BigInt(row?.id ?? "0");
}

/** What a disconnect missed in notifications, for the stream's replay-or-resync decision. */
export async function notificationReplayGap(
  sql: SQL,
  memberId: string,
  afterId: bigint,
): Promise<{ readonly missed: number; readonly oldest: Date | null }> {
  const [row] = (await sql`
    SELECT count(*)::int AS missed, min(created_at) AS oldest
    FROM core.notifications
    WHERE member_id = ${memberId} AND id > ${afterId}
  `) as Array<{ missed: number; oldest: Date | string | null }>;

  return {
    missed: row?.missed ?? 0,
    oldest: row?.oldest === null || row?.oldest === undefined ? null : new Date(row.oldest),
  };
}

/** The erasure fence (ADR 0012): only active members get new notifications or deliveries. */
export async function memberIsActive(sql: SQL, memberId: string): Promise<boolean> {
  const [row] = (await sql`
    SELECT 1 AS active FROM core.members WHERE id = ${memberId} AND state = 'active'
  `) as Array<{ active: number }>;

  return row !== undefined;
}
