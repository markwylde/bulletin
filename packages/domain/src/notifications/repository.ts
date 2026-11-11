import type { SQL } from "bun";
import type { StoredEvent } from "../events/outbox.ts";
import { can } from "../permissions/can.ts";
import { loadPermissionSnapshot, type PermissionSnapshot } from "../permissions/snapshot.ts";
import type { ForumTree } from "../permissions/tree.ts";
import { loadForumTree } from "../permissions/tree-store.ts";
import { isNotificationTypeValue } from "./preferences.ts";

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
        WHERE id = ${memberId} AND is_service = false AND state = 'active'
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

export interface NotificationEntry {
  readonly id: string;
  readonly type: NotificationType;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly topicId: string | null;
  readonly topicTitle: string | null;
  readonly topicSlug: string | null;
  readonly postId: string | null;
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
  readonly count: number;
  readonly read_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

/**
 * The member's notifications, newest first. Entries whose content the member can no longer read
 * are omitted: a notification never reveals a topic title after access is lost (notifications
 * spec, ADR 0006).
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
  const tree = options.tree ?? (await loadForumTree(sql));
  const snapshot =
    options.snapshot ?? (await loadPermissionSnapshot(sql, memberId, { tree, sessionId: null }));
  const rows = (await sql`
    SELECT
      n.id::text AS id,
      n.type,
      n.actor_id::text AS actor_id,
      a.display_name AS actor_name,
      n.topic_id::text AS topic_id,
      t.title AS topic_title,
      t.slug AS topic_slug,
      n.forum_id::text AS forum_id,
      n.post_id::text AS post_id,
      n.count,
      n.read_at,
      n.created_at,
      n.updated_at
    FROM core.notifications n
    LEFT JOIN core.members a ON a.id = n.actor_id
    LEFT JOIN core.topics t ON t.id = n.topic_id
    WHERE n.member_id = ${memberId}
      AND coalesce((
        SELECT p.enabled FROM core.notification_preferences p
        WHERE p.member_id = n.member_id AND p.type = n.type AND p.channel = 'in_app'
      ), true)
    ORDER BY n.updated_at DESC, n.id DESC
    LIMIT ${options.limit ?? 100} OFFSET ${options.offset ?? 0}
  `) as NotificationListRow[];
  const entries: NotificationEntry[] = [];

  for (const row of rows) {
    if (
      row.forum_id !== null &&
      !(await can(sql, memberId, "read", { forumId: row.forum_id, tree, snapshot }))
    ) {
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
      count: row.count,
      read: row.read_at !== null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
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
    SELECT n.forum_id::text AS forum_id, count(*)::int AS count
    FROM core.notifications n
    WHERE n.member_id = ${memberId}
      AND n.read_at IS NULL
      AND coalesce((
        SELECT p.enabled FROM core.notification_preferences p
        WHERE p.member_id = n.member_id AND p.type = n.type AND p.channel = 'in_app'
      ), true)
    GROUP BY n.forum_id
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
  readonly kind: "topic" | "reply";
  readonly topicId: string;
  readonly title: string;
  readonly slug: string;
  readonly forumId: string;
  readonly postId: string | null;
  readonly actorName: string | null;
  readonly createdAt: Date;
}

interface DigestRow {
  readonly topic_id: string;
  readonly title: string;
  readonly slug: string;
  readonly forum_id: string;
  readonly post_id: string | null;
  readonly actor_name: string | null;
  readonly created_at: Date | string;
}

/**
 * New activity since the window in followed topics and followed forums (including their
 * descendants), with `can()` applied at build time. One entry per topic: a new reply wins over
 * the topic row when both apply.
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
  const [replies, topics] = (await Promise.all([
    sql`
      SELECT DISTINCT ON (t.id)
        t.id::text AS topic_id, t.title, t.slug, t.forum_id::text AS forum_id,
        p.id::text AS post_id, a.display_name AS actor_name, p.created_at
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
        NULL::text AS post_id, a.display_name AS actor_name, t.created_at
      FROM core.followed_forums ff
      JOIN core.forums followed ON followed.id = ff.forum_id
      JOIN core.forums target ON target.path <@ followed.path
      JOIN core.topics t ON t.forum_id = target.id
        AND t.created_at > ${options.since}
        AND t.created_at <= ${until}
      LEFT JOIN core.members a ON a.id = t.starter_id
      WHERE ff.member_id = ${memberId}
      ORDER BY t.id, t.created_at DESC
    `,
  ])) as [DigestRow[], DigestRow[]];
  const byTopic = new Map<string, DigestItem>();

  for (const row of topics) {
    byTopic.set(row.topic_id, {
      kind: "topic",
      topicId: row.topic_id,
      title: row.title,
      slug: row.slug,
      forumId: row.forum_id,
      postId: row.post_id,
      actorName: row.actor_name,
      createdAt: new Date(row.created_at),
    });
  }

  for (const row of replies) {
    byTopic.set(row.topic_id, {
      kind: "reply",
      topicId: row.topic_id,
      title: row.title,
      slug: row.slug,
      forumId: row.forum_id,
      postId: row.post_id,
      actorName: row.actor_name,
      createdAt: new Date(row.created_at),
    });
  }

  const readable: DigestItem[] = [];

  for (const item of byTopic.values()) {
    if (await can(sql, memberId, "read", { forumId: item.forumId, tree, snapshot })) {
      readable.push(item);
    }
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
}

/**
 * The context the email job needs, or null when the intent is delivered or the referenced topic
 * is no longer readable by the recipient (authorisation at delivery, ADR 0011).
 */
export async function notificationEmailContext(
  sql: SQL,
  intentId: string,
): Promise<NotificationEmailContext | null> {
  const [row] = (await sql`
    SELECT
      i.member_id::text AS member_id,
      m.locale,
      m.display_name AS recipient_name,
      n.type,
      a.display_name AS actor_name,
      n.forum_id::text AS forum_id,
      n.topic_id::text AS topic_id,
      t.title AS topic_title,
      t.slug AS topic_slug,
      n.post_id::text AS post_id
    FROM core.delivery_intents i
    JOIN core.notifications n ON n.id = i.ref_id AND n.member_id = i.member_id
    JOIN core.members m ON m.id = i.member_id
    LEFT JOIN core.members a ON a.id = n.actor_id
    LEFT JOIN core.topics t ON t.id = n.topic_id
    WHERE i.id = ${intentId}
      AND i.kind = 'notification'
      AND i.channel = 'email'
      AND i.delivered_at IS NULL
  `) as Array<{
    member_id: string;
    locale: string | null;
    recipient_name: string | null;
    type: string;
    actor_name: string | null;
    forum_id: string | null;
    topic_id: string | null;
    topic_title: string | null;
    topic_slug: string | null;
    post_id: string | null;
  }>;

  if (row === undefined || !isNotificationTypeValue(row.type)) {
    return null;
  }

  if (row.forum_id !== null) {
    const tree = await loadForumTree(sql);
    const snapshot = await loadPermissionSnapshot(sql, row.member_id, { tree, sessionId: null });
    const readable = await can(sql, row.member_id, "read", {
      forumId: row.forum_id,
      tree,
      snapshot,
    });

    if (!readable) {
      return null;
    }
  }

  return {
    memberId: row.member_id,
    locale: row.locale,
    recipientName: row.recipient_name,
    type: row.type,
    actorName: row.actor_name,
    topicId: row.topic_id,
    topicTitle: row.topic_title,
    topicSlug: row.topic_slug,
    postId: row.post_id,
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
