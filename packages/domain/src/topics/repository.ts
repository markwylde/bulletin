import type { QuotePipeline, QuoteSource, QuoteSourceRef } from "@bulletin/content";
import type { SQL } from "bun";
import { restartOrphanClock } from "../attachments/store.ts";
import { insertQuoteSnapshot } from "../content/quotes.ts";
import type { ForumAction, ModeratorPower } from "../permissions/actions.ts";
import { can } from "../permissions/can.ts";
import { loadMergedGroupSettings } from "../permissions/store.ts";
import type { ForumTree } from "../permissions/tree.ts";

export type PostVisibility = "visible" | "unapproved" | "soft_deleted";
export type ForumPrefixMode = "none" | "optional" | "required";

export interface ForumTopicTarget {
  readonly id: string;
  readonly type: "category" | "forum" | "redirect";
  readonly prefixMode: ForumPrefixMode;
}

export interface TopicWriteRecord {
  readonly id: string;
  readonly forumId: string;
  readonly title: string;
  readonly slug: string;
  readonly prefixId: string | null;
  readonly starterId: string | null;
  readonly pinned: boolean;
  readonly locked: boolean;
  readonly firstPostId: string | null;
  readonly lastPostId: string | null;
  readonly lastPostAt: Date | null;
  readonly movedTo: string | null;
}

export interface PostWriteRecord {
  readonly id: string;
  readonly topicId: string;
  readonly forumId: string;
  readonly authorId: string | null;
  readonly visibility: PostVisibility;
  readonly position: number;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly editedBy: string | null;
  readonly bodyMd: string;
  readonly bodyHtml: string;
  readonly bodyText: string;
  readonly renderVersion: number;
  readonly sanitiserVersion: number;
  readonly topicLocked: boolean;
  readonly topicMovedTo: string | null;
}

interface ForumTargetRow {
  readonly id: string;
  readonly type: ForumTopicTarget["type"];
  readonly prefix_mode: ForumPrefixMode;
}

interface TopicRow {
  readonly id: string;
  readonly forum_id: string;
  readonly title: string;
  readonly slug: string;
  readonly prefix_id: string | null;
  readonly starter_id: string | null;
  readonly pinned: boolean;
  readonly locked: boolean;
  readonly first_post_id: string | null;
  readonly last_post_id: string | null;
  readonly last_post_at: Date | null;
  readonly moved_to: string | null;
}

interface PostRow {
  readonly id: string;
  readonly topic_id: string;
  readonly forum_id: string;
  readonly author_id: string | null;
  readonly visibility: PostVisibility;
  readonly position: number;
  readonly created_at: Date;
  readonly edited_at: Date | null;
  readonly edited_by: string | null;
  readonly body_md: string;
  readonly body_html: string;
  readonly body_text: string;
  readonly render_version: number;
  readonly sanitiser_version: number;
  readonly topic_locked: boolean;
  readonly topic_moved_to: string | null;
}

function topicRecord(row: TopicRow): TopicWriteRecord {
  return {
    id: row.id,
    forumId: row.forum_id,
    title: row.title,
    slug: row.slug,
    prefixId: row.prefix_id,
    starterId: row.starter_id,
    pinned: row.pinned,
    locked: row.locked,
    firstPostId: row.first_post_id,
    lastPostId: row.last_post_id,
    lastPostAt: row.last_post_at,
    movedTo: row.moved_to,
  };
}

function postRecord(row: PostRow): PostWriteRecord {
  return {
    id: row.id,
    topicId: row.topic_id,
    forumId: row.forum_id,
    authorId: row.author_id,
    visibility: row.visibility,
    position: row.position,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    editedBy: row.edited_by,
    bodyMd: row.body_md,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    renderVersion: row.render_version,
    sanitiserVersion: row.sanitiser_version,
    topicLocked: row.topic_locked,
    topicMovedTo: row.topic_moved_to,
  };
}

export async function loadForumTarget(sql: SQL, forumId: string): Promise<ForumTopicTarget | null> {
  const rows = (await sql`
    SELECT id, type, prefix_mode FROM core.forums WHERE id = ${forumId}
  `) as ForumTargetRow[];
  const row = rows[0];

  return row === undefined ? null : { id: row.id, type: row.type, prefixMode: row.prefix_mode };
}

export async function prefixEnabledForForum(
  sql: SQL,
  forumId: string,
  prefixId: string,
): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM core.forum_prefixes
    WHERE forum_id = ${forumId} AND prefix_id = ${prefixId}
  `) as unknown[];

  return rows.length > 0;
}

export async function actorCanUsePrefix(
  sql: SQL,
  actorId: string,
  prefixId: string,
): Promise<boolean> {
  return can(sql, actorId, "view_prefix", { prefixId });
}

export async function actorCanForumAction(
  sql: SQL,
  actorId: string,
  action: ForumAction,
  forumId: string,
  tree: ForumTree,
  sessionId: string | null = null,
): Promise<boolean> {
  return can(sql, actorId, action, { forumId, tree, sessionId });
}

export async function actorCanModerate(
  sql: SQL,
  actorId: string,
  power: ModeratorPower,
  forumId: string,
  tree: ForumTree,
  sessionId: string | null = null,
): Promise<boolean> {
  return can(sql, actorId, power, { forumId, tree, sessionId });
}

/** The author's edit window in minutes; zero means no time limit (IPB semantics). */
export async function editWindowMinutes(sql: SQL, memberId: string): Promise<number> {
  const settings = await loadMergedGroupSettings(sql, memberId);
  const value = settings["posting.edit_window_minutes"];

  return typeof value === "number" ? value : 0;
}

export async function memberMayDeleteOwnPosts(sql: SQL, memberId: string): Promise<boolean> {
  const settings = await loadMergedGroupSettings(sql, memberId);
  return settings["posting.can_delete_own"] === true;
}

export async function loadTopicForWrite(
  sql: SQL,
  topicId: string,
): Promise<TopicWriteRecord | null> {
  const rows = (await sql`
    SELECT
      t.id, t.forum_id, t.title, t.slug, t.prefix_id, t.starter_id, t.pinned, t.locked,
      t.first_post_id, t.last_post_id, t.last_post_at, t.moved_to
    FROM core.topics t
    WHERE t.id = ${topicId}
  `) as TopicRow[];
  const row = rows[0];

  return row === undefined ? null : topicRecord(row);
}

/** Locks the topic row; every position/counter write for the topic happens under this lock. */
export async function lockTopicForWrite(
  tx: SQL,
  topicId: string,
): Promise<TopicWriteRecord | null> {
  const rows = (await tx`
    SELECT
      t.id, t.forum_id, t.title, t.slug, t.prefix_id, t.starter_id, t.pinned, t.locked,
      t.first_post_id, t.last_post_id, t.last_post_at, t.moved_to
    FROM core.topics t
    WHERE t.id = ${topicId}
    FOR UPDATE
  `) as TopicRow[];
  const row = rows[0];

  return row === undefined ? null : topicRecord(row);
}

export async function loadPostForWrite(sql: SQL, postId: string): Promise<PostWriteRecord | null> {
  const rows = (await sql`
    SELECT
      p.id, p.topic_id, t.forum_id, p.author_id, p.visibility, p.position, p.created_at,
      p.edited_at, p.edited_by, p.body_md, p.body_html, p.body_text,
      p.render_version, p.sanitiser_version, t.locked AS topic_locked,
      t.moved_to AS topic_moved_to
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ${postId}
  `) as PostRow[];
  const row = rows[0];

  return row === undefined ? null : postRecord(row);
}

export async function lockPostForWrite(tx: SQL, postId: string): Promise<PostWriteRecord | null> {
  const rows = (await tx`
    SELECT
      p.id, p.topic_id, t.forum_id, p.author_id, p.visibility, p.position, p.created_at,
      p.edited_at, p.edited_by, p.body_md, p.body_html, p.body_text,
      p.render_version, p.sanitiser_version, t.locked AS topic_locked,
      t.moved_to AS topic_moved_to
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ${postId}
    FOR UPDATE OF p
  `) as PostRow[];
  const row = rows[0];

  return row === undefined ? null : postRecord(row);
}

export async function insertTopic(
  tx: SQL,
  input: {
    readonly forumId: string;
    readonly title: string;
    readonly slug: string;
    readonly prefixId: string | null;
    readonly starterId: string;
  },
): Promise<string> {
  const rows = (await tx`
    INSERT INTO core.topics (forum_id, title, slug, prefix_id, starter_id)
    VALUES (${input.forumId}, ${input.title}, ${input.slug}, ${input.prefixId}, ${input.starterId})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const id = rows[0]?.id;

  if (id === undefined) {
    throw new Error("Could not insert topic");
  }

  return id;
}

export interface NewPostRecord {
  readonly id: string;
  readonly position: number;
  readonly createdAt: Date;
}

export async function insertPost(
  tx: SQL,
  input: {
    readonly topicId: string;
    readonly authorId: string;
    readonly bodyMd: string;
    readonly bodyHtml: string;
    readonly bodyText: string;
    readonly renderVersion: number;
    readonly sanitiserVersion: number;
    readonly quotedForumIds: readonly string[];
    /** Members mentioned in the content; the notification subscriber reads these directly. */
    readonly mentionedMemberIds: readonly string[];
    /** Posts this post quotes, for quote notifications. */
    readonly quotedPostIds: readonly string[];
  },
): Promise<NewPostRecord> {
  const quoted = input.quotedForumIds.length === 0 ? "{}" : `{${input.quotedForumIds.join(",")}}`;
  const mentioned =
    input.mentionedMemberIds.length === 0 ? "{}" : `{${input.mentionedMemberIds.join(",")}}`;
  const quotedPosts =
    input.quotedPostIds.length === 0 ? "{}" : `{${input.quotedPostIds.join(",")}}`;
  const rows = (await tx`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text,
      render_version, sanitiser_version, quoted_forum_ids, mentioned_member_ids,
      quoted_post_ids, position
    )
    VALUES (
      ${input.topicId}, ${input.authorId}, ${input.bodyMd}, ${input.bodyHtml}, ${input.bodyText},
      ${input.renderVersion}, ${input.sanitiserVersion}, ${quoted}::bigint[],
      ${mentioned}::bigint[], ${quotedPosts}::bigint[],
      (SELECT COALESCE(MAX(position), 0) + 1 FROM core.posts WHERE topic_id = ${input.topicId})
    )
    RETURNING id::text AS id, position, created_at
  `) as Array<{ id: string; position: number; created_at: Date }>;
  const row = rows[0];

  if (row === undefined) {
    throw new Error("Could not insert post");
  }

  // Wake readers' streams for this topic; they re-read durable posts and filter by can().
  await tx`SELECT pg_notify('topic_activity', ${input.topicId})`;
  return { id: row.id, position: row.position, createdAt: row.created_at };
}

export async function completeNewTopic(
  tx: SQL,
  input: {
    readonly topicId: string;
    readonly forumId: string;
    readonly postId: string;
    readonly authorId: string;
    readonly createdAt: Date;
  },
): Promise<void> {
  await tx`
    UPDATE core.topics
    SET first_post_id = ${input.postId},
        last_post_id = ${input.postId},
        last_post_at = ${input.createdAt},
        updated_at = now()
    WHERE id = ${input.topicId}
  `;
  await tx`
    UPDATE core.forums
    SET topic_count = topic_count + 1,
        post_count = post_count + 1,
        updated_at = now()
    WHERE id = ${input.forumId}
  `;
  await tx`
    UPDATE core.forums
    SET last_topic_id = ${input.topicId},
        last_post_id = ${input.postId},
        last_post_member_id = ${input.authorId},
        last_post_at = ${input.createdAt},
        updated_at = now()
    WHERE id = ${input.forumId}
      AND (
        last_post_at IS NULL
        OR last_post_at < ${input.createdAt}
        OR (
          last_post_at = ${input.createdAt}
          AND (last_post_id IS NULL OR last_post_id < ${input.postId})
        )
      )
  `;
  await tx`
    UPDATE core.members SET post_count = post_count + 1 WHERE id = ${input.authorId}
  `;
}

export async function recordReply(
  tx: SQL,
  input: {
    readonly topicId: string;
    readonly forumId: string;
    readonly postId: string;
    readonly authorId: string;
    readonly createdAt: Date;
  },
): Promise<void> {
  await tx`
    UPDATE core.topics
    SET reply_count = reply_count + 1,
        updated_at = now()
    WHERE id = ${input.topicId}
  `;
  await tx`
    UPDATE core.topics
    SET last_post_id = ${input.postId},
        last_post_at = ${input.createdAt},
        updated_at = now()
    WHERE id = ${input.topicId}
      AND (
        last_post_at IS NULL
        OR last_post_at < ${input.createdAt}
        OR (
          last_post_at = ${input.createdAt}
          AND (last_post_id IS NULL OR last_post_id < ${input.postId})
        )
      )
  `;
  await tx`
    UPDATE core.forums
    SET post_count = post_count + 1,
        updated_at = now()
    WHERE id = ${input.forumId}
  `;
  await tx`
    UPDATE core.forums
    SET last_topic_id = ${input.topicId},
        last_post_id = ${input.postId},
        last_post_member_id = ${input.authorId},
        last_post_at = ${input.createdAt},
        updated_at = now()
    WHERE id = ${input.forumId}
      AND (
        last_post_at IS NULL
        OR last_post_at < ${input.createdAt}
        OR (
          last_post_at = ${input.createdAt}
          AND (last_post_id IS NULL OR last_post_id < ${input.postId})
        )
      )
  `;
  await tx`
    UPDATE core.members SET post_count = post_count + 1 WHERE id = ${input.authorId}
  `;
}

export async function insertPostRevision(tx: SQL, previous: PostWriteRecord): Promise<void> {
  await tx`
    INSERT INTO core.post_revisions (
      post_id, body_md, body_html, body_text, render_version, sanitiser_version,
      editor_id, edited_at
    )
    VALUES (
      ${previous.id}, ${previous.bodyMd}, ${previous.bodyHtml}, ${previous.bodyText},
      ${previous.renderVersion}, ${previous.sanitiserVersion},
      ${previous.editedBy ?? previous.authorId},
      ${previous.editedAt ?? previous.createdAt}
    )
  `;
}

export async function updatePostRendering(
  tx: SQL,
  input: {
    readonly postId: string;
    readonly bodyMd: string;
    readonly bodyHtml: string;
    readonly bodyText: string;
    readonly renderVersion: number;
    readonly sanitiserVersion: number;
    readonly quotedForumIds: readonly string[];
    readonly mentionedMemberIds: readonly string[];
    readonly quotedPostIds: readonly string[];
    readonly editedBy: string;
  },
): Promise<void> {
  const quoted = input.quotedForumIds.length === 0 ? "{}" : `{${input.quotedForumIds.join(",")}}`;
  const mentioned =
    input.mentionedMemberIds.length === 0 ? "{}" : `{${input.mentionedMemberIds.join(",")}}`;
  const quotedPosts =
    input.quotedPostIds.length === 0 ? "{}" : `{${input.quotedPostIds.join(",")}}`;
  await tx`
    UPDATE core.posts
    SET body_md = ${input.bodyMd},
        body_html = ${input.bodyHtml},
        body_text = ${input.bodyText},
        render_version = ${input.renderVersion},
        sanitiser_version = ${input.sanitiserVersion},
        quoted_forum_ids = ${quoted}::bigint[],
        mentioned_member_ids = ${mentioned}::bigint[],
        quoted_post_ids = ${quotedPosts}::bigint[],
        edited_at = now(),
        edited_by = ${input.editedBy}
    WHERE id = ${input.postId}
  `;
}

/** A redacting moderator edit hides every earlier version from public history (ADR 0007). */
export async function protectPostRevisions(tx: SQL, postId: string): Promise<void> {
  await tx`
    UPDATE core.post_revisions SET protected = true
    WHERE post_id = ${postId} AND NOT protected
  `;
}

export async function setPostVisibility(
  tx: SQL,
  postId: string,
  visibility: PostVisibility,
): Promise<void> {
  await tx`UPDATE core.posts SET visibility = ${visibility} WHERE id = ${postId}`;
}

export async function deletePostRow(tx: SQL, postId: string): Promise<void> {
  // Collect links before the post cascade removes them; the orphan sweep must eventually see
  // attachments that lost their last reference (ADR 0019).
  const removed = (await tx`
    DELETE FROM core.post_attachments
    WHERE post_id = ${postId}
    RETURNING attachment_id::text AS attachment_id
  `) as Array<{ attachment_id: string }>;

  await tx`DELETE FROM core.posts WHERE id = ${postId}`;
  await restartOrphanClock(
    tx,
    removed.map((row) => row.attachment_id),
  );
}

export async function deleteTopicRow(tx: SQL, topicId: string): Promise<void> {
  const removed = (await tx`
    DELETE FROM core.post_attachments
    WHERE post_id IN (SELECT id FROM core.posts WHERE topic_id = ${topicId})
    RETURNING attachment_id::text AS attachment_id
  `) as Array<{ attachment_id: string }>;

  await tx`DELETE FROM core.topics WHERE id = ${topicId}`;
  await restartOrphanClock(
    tx,
    removed.map((row) => row.attachment_id),
  );
}

export async function visiblePostCount(tx: SQL, topicId: string): Promise<number> {
  const rows = (await tx`
    SELECT count(*)::int AS count FROM core.posts
    WHERE topic_id = ${topicId} AND visibility = 'visible'
  `) as Array<{ count: number }>;

  return rows[0]?.count ?? 0;
}

export async function visiblePostCountsByAuthor(
  tx: SQL,
  topicId: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = (await tx`
    SELECT author_id::text AS author_id, count(*)::int AS count
    FROM core.posts
    WHERE topic_id = ${topicId} AND visibility = 'visible' AND author_id IS NOT NULL
    GROUP BY author_id
  `) as Array<{ author_id: string; count: number }>;

  return new Map(rows.map((row) => [row.author_id, row.count]));
}

export async function adjustForumPostCount(tx: SQL, forumId: string, delta: number): Promise<void> {
  await tx`
    UPDATE core.forums
    SET post_count = GREATEST(0, post_count + ${delta}), updated_at = now()
    WHERE id = ${forumId}
  `;
}

export async function adjustForumTopicCount(
  tx: SQL,
  forumId: string,
  delta: number,
): Promise<void> {
  await tx`
    UPDATE core.forums
    SET topic_count = GREATEST(0, topic_count + ${delta}), updated_at = now()
    WHERE id = ${forumId}
  `;
}

export async function adjustMemberPostCount(
  tx: SQL,
  memberId: string,
  delta: number,
): Promise<void> {
  await tx`
    UPDATE core.members SET post_count = GREATEST(0, post_count + ${delta})
    WHERE id = ${memberId}
  `;
}

export async function adjustMemberPostCounts(
  tx: SQL,
  counts: ReadonlyMap<string, number>,
  direction: 1 | -1,
): Promise<void> {
  for (const [memberId, count] of counts) {
    await adjustMemberPostCount(tx, memberId, count * direction);
  }
}

export async function adjustTopicReplyCount(
  tx: SQL,
  topicId: string,
  delta: number,
): Promise<void> {
  await tx`
    UPDATE core.topics
    SET reply_count = GREATEST(0, reply_count + ${delta}), updated_at = now()
    WHERE id = ${topicId}
  `;
}

/** Recomputes visible first/last-post pointers and the reply count for one topic. */
export async function recountTopic(tx: SQL, topicId: string): Promise<void> {
  await tx`
    UPDATE core.topics t
    SET reply_count = GREATEST((
          SELECT count(*) - 1 FROM core.posts
          WHERE topic_id = t.id AND visibility = 'visible'
        ), 0),
        first_post_id = (
          SELECT id FROM core.posts
          WHERE topic_id = t.id AND visibility = 'visible'
          ORDER BY position LIMIT 1
        ),
        last_post_id = (
          SELECT id FROM core.posts
          WHERE topic_id = t.id AND visibility = 'visible'
          ORDER BY position DESC LIMIT 1
        ),
        last_post_at = (
          SELECT created_at FROM core.posts
          WHERE topic_id = t.id AND visibility = 'visible'
          ORDER BY position DESC LIMIT 1
        ),
        updated_at = now()
    WHERE t.id = ${topicId}
  `;
}

/**
 * Recomputes a forum's latest visible post. When `expectedLastPostId` is set the update only
 * runs if that post is still the forum's last post, so a concurrent newer reply is not
 * clobbered by a deletion or move.
 */
export async function refreshForumLastPost(
  tx: SQL,
  forumId: string,
  expectedLastPostId: string | null = null,
): Promise<void> {
  await tx`
    UPDATE core.forums f
    SET last_topic_id = (
          SELECT t.id
          FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
          WHERE t.forum_id = f.id AND p.visibility = 'visible'
          ORDER BY p.created_at DESC, p.id DESC LIMIT 1
        ),
        last_post_id = (
          SELECT p.id
          FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
          WHERE t.forum_id = f.id AND p.visibility = 'visible'
          ORDER BY p.created_at DESC, p.id DESC LIMIT 1
        ),
        last_post_member_id = (
          SELECT p.author_id
          FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
          WHERE t.forum_id = f.id AND p.visibility = 'visible'
          ORDER BY p.created_at DESC, p.id DESC LIMIT 1
        ),
        last_post_at = (
          SELECT p.created_at
          FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
          WHERE t.forum_id = f.id AND p.visibility = 'visible'
          ORDER BY p.created_at DESC, p.id DESC LIMIT 1
        ),
        updated_at = now()
    WHERE f.id = ${forumId}
      AND (${expectedLastPostId}::bigint IS NULL OR f.last_post_id = ${expectedLastPostId})
  `;
}

export async function setTopicLocked(tx: SQL, topicId: string, locked: boolean): Promise<void> {
  await tx`UPDATE core.topics SET locked = ${locked}, updated_at = now() WHERE id = ${topicId}`;
}

export async function setTopicPinned(tx: SQL, topicId: string, pinned: boolean): Promise<void> {
  await tx`UPDATE core.topics SET pinned = ${pinned}, updated_at = now() WHERE id = ${topicId}`;
}

export async function moveTopicRow(tx: SQL, topicId: string, forumId: string): Promise<void> {
  await tx`
    UPDATE core.topics SET forum_id = ${forumId}, updated_at = now() WHERE id = ${topicId}
  `;
}

export async function insertMovedStub(
  tx: SQL,
  input: {
    readonly topic: TopicWriteRecord;
    readonly forumId: string;
    readonly stubExpiresAt: Date;
  },
): Promise<void> {
  await tx`
    INSERT INTO core.topics (
      forum_id, title, slug, prefix_id, starter_id, locked, last_post_at, moved_to,
      stub_expires_at
    )
    VALUES (
      ${input.forumId}, ${input.topic.title}, ${input.topic.slug},
      ${input.topic.prefixId}, ${input.topic.starterId}, true, now(),
      ${input.topic.id}, ${input.stubExpiresAt}
    )
  `;
}

/**
 * The write-side quote resolver (ADR 0007). Read access is checked with `can()` at save
 * time, and the source forum is stored so reads can declare its `read` bit in their deps.
 */
export function createPostQuotePipeline(
  sql: SQL,
  tree: ForumTree,
  sessionId: string | null = null,
): QuotePipeline {
  return {
    resolver: {
      async canRead(ref: QuoteSourceRef, authorId: string): Promise<boolean> {
        if (ref.kind !== "post") {
          return false;
        }

        const rows = (await sql`
          SELECT p.visibility, p.author_id::text AS author_id, t.forum_id
          FROM core.posts p
          JOIN core.topics t ON t.id = p.topic_id
          WHERE p.id = ${ref.id}
        `) as Array<{
          visibility: PostVisibility;
          author_id: string | null;
          forum_id: string;
        }>;
        const source = rows[0];

        if (source === undefined || source.visibility === "soft_deleted") {
          return false;
        }

        if (
          source.visibility === "unapproved" &&
          source.author_id !== authorId &&
          !(await can(sql, authorId, "see_unapproved", {
            forumId: source.forum_id,
            tree,
            sessionId,
          }))
        ) {
          return false;
        }

        return can(sql, authorId, "read", { forumId: source.forum_id, tree, sessionId });
      },
      async load(ref: QuoteSourceRef): Promise<QuoteSource | null> {
        if (ref.kind !== "post") {
          return null;
        }

        const rows = (await sql`
          SELECT p.id::text AS id, p.author_id::text AS author_id, p.body_md, t.forum_id
          FROM core.posts p
          JOIN core.topics t ON t.id = p.topic_id
          WHERE p.id = ${ref.id} AND p.visibility <> 'soft_deleted'
        `) as Array<{
          id: string;
          author_id: string | null;
          body_md: string;
          forum_id: string;
        }>;
        const source = rows[0];

        if (source === undefined) {
          return null;
        }

        return {
          ref: { kind: "post", id: source.id },
          sourceAuthorId: source.author_id,
          bodyMd: source.body_md,
          contextId: source.forum_id,
        };
      },
    },
    snapshots: {
      create: (draft) => insertQuoteSnapshot(sql, draft),
    },
  };
}
