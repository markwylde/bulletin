import { type ReplaceWords, replaceWordsInText } from "@bulletin/content";
import type { Locale } from "@bulletin/i18n";
import type { SQL } from "bun";
import { can } from "../../permissions/can.ts";
import { loadPermissionSnapshot, type PermissionSnapshot } from "../../permissions/snapshot.ts";
import type { ForumTree } from "../../permissions/tree.ts";
import { loadForumTree } from "../../permissions/tree-store.ts";

export const TOPIC_LIST_SORTS = ["last_post", "start_date", "title"] as const;
export type TopicListSort = (typeof TOPIC_LIST_SORTS)[number];

export const TOPIC_VISIBILITIES = ["visible", "unapproved", "soft_deleted"] as const;
export type TopicPostVisibility = (typeof TOPIC_VISIBILITIES)[number];

export interface TopicRecord {
  readonly id: string;
  readonly forumId: string;
  readonly title: string;
  readonly slug: string;
  readonly prefixId: string | null;
  readonly starterId: string | null;
  readonly pinned: boolean;
  readonly locked: boolean;
  readonly replyCount: number;
  readonly viewCount: string;
  readonly firstPostId: string | null;
  readonly lastPostId: string | null;
  readonly lastPostAt: Date | null;
  readonly movedTo: string | null;
  readonly stubExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly visibility: TopicPostVisibility;
  readonly holdReason: string | null;
}

export interface TopicListRow {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly pinned: boolean;
  readonly locked: boolean;
  readonly movedTo: string | null;
  readonly prefixId: string | null;
  readonly prefixKey: string | null;
  readonly prefixLabel: string | null;
  readonly prefixColour: string | null;
  readonly starterId: string | null;
  readonly starterName: string | null;
  readonly replyCount: number;
  readonly viewCount: string;
  readonly lastPostId: string | null;
  readonly lastPostAt: Date | null;
  readonly lastPostMemberName: string | null;
}

export interface TopicListPage {
  readonly rows: readonly TopicListRow[];
  readonly total: number;
}

export interface TopicPostRow {
  readonly id: string;
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly bodyMd: string;
  readonly bodyHtml: string;
  readonly bodyText: string;
  readonly renderVersion: number;
  readonly sanitiserVersion: number;
  readonly visibility: TopicPostVisibility;
  readonly position: number;
  readonly quotedForumIds: readonly string[];
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly editedById: string | null;
  readonly editedByName: string | null;
}

export interface TopicPostPage {
  readonly rows: readonly TopicPostRow[];
  readonly total: number;
}

export interface TopicPagePosition {
  readonly page: number;
  readonly position: number;
  readonly before: number;
  readonly total: number;
}

export interface MemberCardRecord {
  readonly id: string;
  readonly displayName: string | null;
  readonly postCount: number;
  readonly groupTitle: string | null;
  readonly joinedAt: Date;
  readonly avatarHash: string | null;
  readonly reputation: number;
  readonly customTitle: string | null;
  readonly rankTitle: string | null;
  readonly rankPips: number;
  readonly rankImageKey: string | null;
  readonly featuredBadges: readonly { readonly label: string; readonly imageKey: string | null }[];
}

export interface QuoteSourceRecord {
  readonly postId: string;
  readonly topicId: string;
  readonly topicSlug: string;
  readonly forumId: string;
  readonly visibility: TopicPostVisibility;
  readonly authorId: string | null;
}

export interface PostHistoryContext {
  readonly id: string;
  readonly topicId: string;
  readonly topicSlug: string;
  readonly forumId: string;
  readonly authorId: string | null;
  readonly bodyMd: string;
  readonly bodyHtml: string;
  readonly visibility: TopicPostVisibility;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly editedByName: string | null;
}

export interface PostRevisionRow {
  readonly id: string;
  readonly bodyMd: string;
  readonly bodyHtml: string;
  readonly editorId: string | null;
  readonly editorName: string | null;
  readonly editedAt: Date;
  readonly protected: boolean;
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
  readonly reply_count: number;
  readonly view_count: string;
  readonly first_post_id: string | null;
  readonly last_post_id: string | null;
  readonly last_post_at: Date | null;
  readonly moved_to: string | null;
  readonly stub_expires_at: Date | null;
  readonly created_at: Date;
  readonly visibility: TopicPostVisibility;
  readonly hold_reason: string | null;
}

function toTopic(row: TopicRow): TopicRecord {
  return {
    id: row.id,
    forumId: row.forum_id,
    title: row.title,
    slug: row.slug,
    prefixId: row.prefix_id,
    starterId: row.starter_id,
    pinned: row.pinned,
    locked: row.locked,
    replyCount: row.reply_count,
    viewCount: row.view_count,
    firstPostId: row.first_post_id,
    lastPostId: row.last_post_id,
    lastPostAt: row.last_post_at,
    movedTo: row.moved_to,
    stubExpiresAt: row.stub_expires_at,
    createdAt: row.created_at,
    visibility: row.visibility,
    holdReason: row.hold_reason,
  };
}

export async function readTopic(sql: SQL, topicId: string): Promise<TopicRecord | null> {
  if (!/^\d+$/.test(topicId)) {
    return null;
  }

  const rows = (await sql`
    SELECT
      t.id, t.forum_id, t.title, t.slug, t.prefix_id, t.starter_id, t.pinned, t.locked,
      t.reply_count, t.view_count::text AS view_count, t.first_post_id, t.last_post_id,
      t.last_post_at, t.moved_to, t.stub_expires_at, t.created_at, t.visibility,
      t.hold_reason
    FROM core.topics t
    WHERE t.id = ${topicId}
  `) as TopicRow[];
  const row = rows[0];

  return row === undefined ? null : toTopic(row);
}

export async function readTopicPrefix(
  sql: SQL,
  prefixId: string,
  locale: string,
): Promise<{ readonly label: string; readonly colour: string } | null> {
  const rows = (await sql`
    SELECT
      COALESCE(label.label, en.label, prefix.key) AS label,
      prefix.colour
    FROM core.prefixes prefix
    LEFT JOIN core.prefix_labels label
      ON label.prefix_id = prefix.id AND label.locale = ${locale}
    LEFT JOIN core.prefix_labels en
      ON en.prefix_id = prefix.id AND en.locale = 'en'
    WHERE prefix.id = ${prefixId}
  `) as Array<{ label: string; colour: string }>;
  const row = rows[0];

  return row === undefined ? null : { label: row.label, colour: row.colour };
}

export async function readTopicViewCount(sql: SQL, topicId: string): Promise<string> {
  const rows = (await sql`
    SELECT view_count::text AS view_count FROM core.topics WHERE id = ${topicId}
  `) as Array<{ view_count: string }>;

  return rows[0]?.view_count ?? "0";
}

export async function readTopicTarget(
  sql: SQL,
  topicId: string,
): Promise<{ readonly id: string; readonly slug: string } | null> {
  const rows = (await sql`
    SELECT id::text AS id, slug FROM core.topics WHERE id = ${topicId}
  `) as Array<{ id: string; slug: string }>;

  return rows[0] ?? null;
}

interface TopicListRowSql {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly pinned: boolean;
  readonly locked: boolean;
  readonly moved_to: string | null;
  readonly prefix_id: string | null;
  readonly prefix_key: string | null;
  readonly prefix_label: string | null;
  readonly prefix_colour: string | null;
  readonly starter_id: string | null;
  readonly starter_name: string | null;
  readonly reply_count: number;
  readonly view_count: string;
  readonly last_post_id: string | null;
  readonly last_post_at: Date | null;
  readonly last_post_member_name: string | null;
}

function toTopicListRow(row: TopicListRowSql): TopicListRow {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    pinned: row.pinned,
    locked: row.locked,
    movedTo: row.moved_to,
    prefixId: row.prefix_id,
    prefixKey: row.prefix_key,
    prefixLabel: row.prefix_label,
    prefixColour: row.prefix_colour,
    starterId: row.starter_id,
    starterName: row.starter_name,
    replyCount: row.reply_count,
    viewCount: row.view_count,
    lastPostId: row.last_post_id,
    lastPostAt: row.last_post_at,
    lastPostMemberName: row.last_post_member_name,
  };
}

/**
 * The forum topic list repository (ADR 0005). Visibility is applied in SQL; a held or deleted
 * post is only counted for a viewer whose bits see it. Moved-topic stubs stay listed until
 * their expiry so readers in the old forum are redirected.
 */
export async function readTopicList(
  sql: SQL,
  input: {
    readonly forumId: string;
    readonly locale: string;
    readonly sort: TopicListSort;
    readonly prefixId: string | null;
    readonly page: number;
    readonly perPage: number;
    readonly seeUnapproved: boolean;
    readonly seeDeleted: boolean;
  },
): Promise<TopicListPage> {
  const offset = (input.page - 1) * input.perPage;
  const rows = (await sql`
    SELECT
      t.id, t.title, t.slug, t.pinned, t.locked, t.moved_to,
      prefix.id AS prefix_id, prefix.key AS prefix_key,
      COALESCE(label.label, prefix.key) AS prefix_label,
      prefix.colour AS prefix_colour,
      t.starter_id, starter.display_name AS starter_name,
      t.reply_count, t.view_count::text AS view_count,
      t.last_post_id, t.last_post_at,
      last_member.display_name AS last_post_member_name
    FROM core.topics t
    LEFT JOIN core.prefixes prefix ON prefix.id = t.prefix_id
    LEFT JOIN core.prefix_labels label
      ON label.prefix_id = t.prefix_id AND label.locale = ${input.locale}
    LEFT JOIN core.members starter ON starter.id = t.starter_id
    LEFT JOIN core.posts last_post ON last_post.id = t.last_post_id
    LEFT JOIN core.members last_member ON last_member.id = last_post.author_id
    WHERE t.forum_id = ${input.forumId}
      AND (
        (
          t.visibility = 'visible'
          AND (
            EXISTS (
              SELECT 1 FROM core.posts p
              WHERE p.topic_id = t.id AND p.visibility = 'visible'
            )
            OR (${input.seeUnapproved} AND EXISTS (
              SELECT 1 FROM core.posts p
              WHERE p.topic_id = t.id AND p.visibility = 'unapproved'
            ))
            OR (${input.seeDeleted} AND EXISTS (
              SELECT 1 FROM core.posts p
              WHERE p.topic_id = t.id AND p.visibility = 'soft_deleted'
            ))
          )
        )
        OR (${input.seeUnapproved} AND t.visibility = 'unapproved')
        OR (${input.seeDeleted} AND t.visibility = 'soft_deleted')
        OR (t.moved_to IS NOT NULL AND t.stub_expires_at > now())
      )
      AND (${input.prefixId}::bigint IS NULL OR t.prefix_id = ${input.prefixId})
    ORDER BY
      t.pinned DESC,
      (CASE WHEN ${input.sort} = 'title' THEN lower(t.title) END) ASC,
      (CASE WHEN ${input.sort} = 'start_date' THEN t.created_at END) DESC,
      (CASE WHEN ${input.sort} = 'last_post' THEN t.last_post_at END) DESC NULLS LAST,
      t.id DESC
    LIMIT ${input.perPage} OFFSET ${offset}
  `) as TopicListRowSql[];
  const [count] = (await sql`
    SELECT count(*)::int AS count
    FROM core.topics t
    WHERE t.forum_id = ${input.forumId}
      AND (
        (
          t.visibility = 'visible'
          AND (
            EXISTS (
              SELECT 1 FROM core.posts p
              WHERE p.topic_id = t.id AND p.visibility = 'visible'
            )
            OR (${input.seeUnapproved} AND EXISTS (
              SELECT 1 FROM core.posts p
              WHERE p.topic_id = t.id AND p.visibility = 'unapproved'
            ))
            OR (${input.seeDeleted} AND EXISTS (
              SELECT 1 FROM core.posts p
              WHERE p.topic_id = t.id AND p.visibility = 'soft_deleted'
            ))
          )
        )
        OR (${input.seeUnapproved} AND t.visibility = 'unapproved')
        OR (${input.seeDeleted} AND t.visibility = 'soft_deleted')
        OR (t.moved_to IS NOT NULL AND t.stub_expires_at > now())
      )
      AND (${input.prefixId}::bigint IS NULL OR t.prefix_id = ${input.prefixId})
  `) as Array<{ count: number }>;

  return { rows: rows.map(toTopicListRow), total: count?.count ?? 0 };
}

interface TopicPostRowSql {
  readonly id: string;
  readonly author_id: string | null;
  readonly author_name: string | null;
  readonly body_md: string;
  readonly body_html: string;
  readonly body_text: string;
  readonly render_version: number;
  readonly sanitiser_version: number;
  readonly visibility: TopicPostVisibility;
  readonly position: number;
  readonly quoted_forum_ids: readonly string[];
  readonly created_at: Date;
  readonly edited_at: Date | null;
  readonly edited_by: string | null;
  readonly edited_by_name: string | null;
}

function toTopicPost(row: TopicPostRowSql): TopicPostRow {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    bodyMd: row.body_md,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    renderVersion: row.render_version,
    sanitiserVersion: row.sanitiser_version,
    visibility: row.visibility,
    position: row.position,
    quotedForumIds: row.quoted_forum_ids ?? [],
    createdAt: row.created_at,
    editedAt: row.edited_at,
    editedById: row.edited_by,
    editedByName: row.edited_by_name,
  };
}

export async function countTopicPosts(
  sql: SQL,
  input: {
    readonly topicId: string;
    readonly seeUnapproved: boolean;
    readonly seeDeleted: boolean;
  },
): Promise<number> {
  const [count] = (await sql`
    SELECT count(*)::int AS count
    FROM core.posts p
    WHERE p.topic_id = ${input.topicId}
      AND (
        p.visibility = 'visible'
        OR (${input.seeUnapproved} AND p.visibility = 'unapproved')
        OR (${input.seeDeleted} AND p.visibility = 'soft_deleted')
      )
  `) as Array<{ count: number }>;

  return count?.count ?? 0;
}

export async function readTopicPostById(
  sql: SQL,
  input: {
    readonly topicId: string;
    readonly postId: string;
    readonly seeUnapproved: boolean;
    readonly seeDeleted: boolean;
  },
): Promise<TopicPostRow | null> {
  const rows = (await sql`
    SELECT
      p.id, p.author_id, author.display_name AS author_name, p.body_md, p.body_html, p.body_text,
      p.render_version, p.sanitiser_version, p.visibility, p.position,
      p.quoted_forum_ids::text[] AS quoted_forum_ids, p.created_at, p.edited_at,
      p.edited_by, editor.display_name AS edited_by_name
    FROM core.posts p
    LEFT JOIN core.members author ON author.id = p.author_id
    LEFT JOIN core.members editor ON editor.id = p.edited_by
    WHERE p.topic_id = ${input.topicId}
      AND p.id = ${input.postId}
      AND (
        p.visibility = 'visible'
        OR (${input.seeUnapproved} AND p.visibility = 'unapproved')
        OR (${input.seeDeleted} AND p.visibility = 'soft_deleted')
      )
  `) as TopicPostRowSql[];
  const row = rows[0];

  return row === undefined ? null : toTopicPost(row);
}

export async function readTopicPostPage(
  sql: SQL,
  input: {
    readonly topicId: string;
    readonly limit: number;
    readonly offset: number;
    readonly seeUnapproved: boolean;
    readonly seeDeleted: boolean;
  },
): Promise<TopicPostPage> {
  const rows = (await sql`
    SELECT
      p.id, p.author_id, author.display_name AS author_name, p.body_md, p.body_html, p.body_text,
      p.render_version, p.sanitiser_version, p.visibility, p.position,
      p.quoted_forum_ids::text[] AS quoted_forum_ids, p.created_at, p.edited_at,
      p.edited_by, editor.display_name AS edited_by_name
    FROM core.posts p
    LEFT JOIN core.members author ON author.id = p.author_id
    LEFT JOIN core.members editor ON editor.id = p.edited_by
    WHERE p.topic_id = ${input.topicId}
      AND (
        p.visibility = 'visible'
        OR (${input.seeUnapproved} AND p.visibility = 'unapproved')
        OR (${input.seeDeleted} AND p.visibility = 'soft_deleted')
      )
    ORDER BY p.position
    LIMIT ${input.limit} OFFSET ${input.offset}
  `) as TopicPostRowSql[];
  const [count] = (await sql`
    SELECT count(*)::int AS count
    FROM core.posts p
    WHERE p.topic_id = ${input.topicId}
      AND (
        p.visibility = 'visible'
        OR (${input.seeUnapproved} AND p.visibility = 'unapproved')
        OR (${input.seeDeleted} AND p.visibility = 'soft_deleted')
      )
  `) as Array<{ count: number }>;

  return { rows: rows.map(toTopicPost), total: count?.count ?? 0 };
}

/** The viewer-specific page containing one post, computed from visible posts before it. */
export async function readTopicPageOfPost(
  sql: SQL,
  input: {
    readonly topicId: string;
    readonly postId: string;
    readonly perPage: number;
    readonly seeUnapproved: boolean;
    readonly seeDeleted: boolean;
  },
): Promise<TopicPagePosition | null> {
  const rows = (await sql`
    SELECT p.id, p.position
    FROM core.posts p
    WHERE p.id = ${input.postId}
      AND p.topic_id = ${input.topicId}
      AND (
        p.visibility = 'visible'
        OR (${input.seeUnapproved} AND p.visibility = 'unapproved')
        OR (${input.seeDeleted} AND p.visibility = 'soft_deleted')
      )
  `) as Array<{ id: string; position: number }>;
  const post = rows[0];

  if (post === undefined) {
    return null;
  }

  const [counts] = (await sql`
    SELECT
      count(*) FILTER (WHERE p.position < ${post.position})::int AS before,
      count(*)::int AS total
    FROM core.posts p
    WHERE p.topic_id = ${input.topicId}
      AND (
        p.visibility = 'visible'
        OR (${input.seeUnapproved} AND p.visibility = 'unapproved')
        OR (${input.seeDeleted} AND p.visibility = 'soft_deleted')
      )
  `) as Array<{ before: number; total: number }>;
  const before = counts?.before ?? 0;

  return {
    page: Math.floor(before / input.perPage) + 1,
    position: post.position,
    before,
    total: counts?.total ?? 0,
  };
}

export interface TopicQuoteReferences {
  readonly forumIds: readonly string[];
  readonly postIds: readonly string[];
}

/** Quote sources on one page, read from the stored placeholders before the cache lookup. */
export async function readQuoteReferencesForPage(
  sql: SQL,
  input: {
    readonly topicId: string;
    readonly limit: number;
    readonly offset: number;
    readonly seeUnapproved: boolean;
    readonly seeDeleted: boolean;
  },
): Promise<TopicQuoteReferences> {
  const rows = (await sql`
    WITH page_posts AS (
      SELECT p.body_html, p.quoted_forum_ids
      FROM core.posts p
      WHERE p.topic_id = ${input.topicId}
        AND (
          p.visibility = 'visible'
          OR (${input.seeUnapproved} AND p.visibility = 'unapproved')
          OR (${input.seeDeleted} AND p.visibility = 'soft_deleted')
        )
      ORDER BY p.position
      LIMIT ${input.limit} OFFSET ${input.offset}
    )
    SELECT
      ARRAY(
        SELECT DISTINCT unnest(quoted_forum_ids)::text FROM page_posts
      ) AS forum_ids,
      ARRAY(
        SELECT DISTINCT match[1]
        FROM page_posts, regexp_matches(body_html, '<bl-quote[^>]*data-source="(\\d+)"', 'g') AS match
      ) AS post_ids
  `) as Array<{ forum_ids: string[]; post_ids: string[] }>;
  const row = rows[0];

  return { forumIds: row?.forum_ids ?? [], postIds: row?.post_ids ?? [] };
}

export async function readQuotedForumIds(
  sql: SQL,
  input: {
    readonly topicId: string;
    readonly limit: number;
    readonly offset: number;
    readonly seeUnapproved: boolean;
    readonly seeDeleted: boolean;
  },
): Promise<readonly string[]> {
  const rows = (await sql`
    WITH page_posts AS (
      SELECT p.id, p.quoted_forum_ids
      FROM core.posts p
      WHERE p.topic_id = ${input.topicId}
        AND (
          p.visibility = 'visible'
          OR (${input.seeUnapproved} AND p.visibility = 'unapproved')
          OR (${input.seeDeleted} AND p.visibility = 'soft_deleted')
        )
      ORDER BY p.position
      LIMIT ${input.limit} OFFSET ${input.offset}
    )
    SELECT DISTINCT unnest(quoted_forum_ids)::text AS forum_id
    FROM page_posts
    ORDER BY forum_id
  `) as Array<{ forum_id: string }>;

  return rows.map((row) => row.forum_id);
}

export interface LatestReadablePost {
  readonly postId: string;
  readonly topicId: string;
  readonly topicSlug: string;
  readonly createdAt: Date;
  readonly memberName: string | null;
}

/** The latest post in one forum the viewer may read; null when every post is hidden. */
export async function latestReadablePost(
  sql: SQL,
  input: {
    readonly forumId: string;
    readonly seeUnapproved: boolean;
    readonly seeDeleted: boolean;
  },
): Promise<LatestReadablePost | null> {
  const rows = (await sql`
    SELECT
      p.id, p.created_at, t.id AS topic_id, t.slug AS topic_slug,
      member.display_name AS member_name
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    LEFT JOIN core.members member ON member.id = p.author_id
    WHERE t.forum_id = ${input.forumId}
      AND (
        p.visibility = 'visible'
        OR (${input.seeUnapproved} AND p.visibility = 'unapproved')
        OR (${input.seeDeleted} AND p.visibility = 'soft_deleted')
      )
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT 1
  `) as Array<{
    id: string;
    created_at: Date;
    topic_id: string;
    topic_slug: string;
    member_name: string | null;
  }>;
  const row = rows[0];

  return row === undefined
    ? null
    : {
        postId: row.id,
        topicId: row.topic_id,
        topicSlug: row.topic_slug,
        createdAt: row.created_at,
        memberName: row.member_name,
      };
}

/** Topic id to forum id for the given IDs, used to filter client-supplied overlay IDs. */
export async function readTopicForumIds(
  sql: SQL,
  topicIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (topicIds.length === 0) {
    return new Map();
  }

  const rows = (await sql`
    SELECT id::text AS id, forum_id::text AS forum_id
    FROM core.topics
    WHERE id = ANY(${`{${topicIds.join(",")}}`}::bigint[])
  `) as Array<{ id: string; forum_id: string }>;

  return new Map(rows.map((row) => [row.id, row.forum_id]));
}

export async function loadQuoteSources(
  sql: SQL,
  postIds: readonly string[],
): Promise<ReadonlyMap<string, QuoteSourceRecord>> {
  if (postIds.length === 0) {
    return new Map();
  }

  const rows = (await sql`
    SELECT
      p.id, p.visibility, p.author_id, t.id AS topic_id, t.slug AS topic_slug, t.forum_id
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ANY(${`{${postIds.join(",")}}`}::bigint[])
      AND t.visibility = 'visible'
  `) as Array<{
    id: string;
    visibility: TopicPostVisibility;
    author_id: string | null;
    topic_id: string;
    topic_slug: string;
    forum_id: string;
  }>;

  return new Map(
    rows.map((row) => [
      row.id,
      {
        postId: row.id,
        topicId: row.topic_id,
        topicSlug: row.topic_slug,
        forumId: row.forum_id,
        visibility: row.visibility,
        authorId: row.author_id,
      },
    ]),
  );
}

export async function loadMemberCards(
  sql: SQL,
  memberIds: readonly string[],
  locale: Locale,
  replaceWords?: ReplaceWords,
): Promise<ReadonlyMap<string, MemberCardRecord>> {
  if (memberIds.length === 0) {
    return new Map();
  }

  const rows = (await sql`
    SELECT
      m.id, m.display_name, m.post_count, m.joined_at, m.avatar_hash, m.reputation,
      m.custom_title,
      g.title AS group_title,
      rank.title_labels->>${locale} AS rank_title,
      COALESCE(rank.title_labels->>${locale}, rank.title_labels->>'en') AS rank_title_local,
      rank.pips AS rank_pips,
      rank.image_key AS rank_image_key
    FROM core.members m
    LEFT JOIN core.member_groups mg ON mg.member_id = m.id AND mg.is_primary
    LEFT JOIN core.groups g ON g.id = mg.group_id
    LEFT JOIN LATERAL (
      SELECT title_labels, pips, image_key
      FROM core.ranks
      WHERE min_posts <= m.post_count
      ORDER BY min_posts DESC
      LIMIT 1
    ) rank ON true
    WHERE m.id = ANY(${`{${memberIds.join(",")}}`}::bigint[])
  `) as Array<{
    id: string;
    display_name: string | null;
    post_count: number;
    joined_at: Date;
    group_title: string | null;
    avatar_hash: string | null;
    reputation: number;
    custom_title: string | null;
    rank_title_local: string | null;
    rank_pips: number | null;
    rank_image_key: string | null;
  }>;
  const featured = (await sql`
    SELECT
      mb.member_id::text AS member_id,
      COALESCE(b.labels->>${locale}, b.labels->>'en', '') AS label,
      b.image_key
    FROM core.member_badges mb
    JOIN core.badges b ON b.id = mb.badge_id
    WHERE mb.member_id = ANY(${`{${memberIds.join(",")}}`}::bigint[])
      AND mb.featured
      AND mb.revoked_at IS NULL
    ORDER BY b.position, b.id
  `) as Array<{ member_id: string; label: string; image_key: string | null }>;
  const badgesByMember = new Map<string, Array<{ label: string; imageKey: string | null }>>();

  for (const row of featured) {
    const list = badgesByMember.get(row.member_id) ?? [];
    list.push({ label: row.label, imageKey: row.image_key });
    badgesByMember.set(row.member_id, list);
  }

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        displayName:
          row.display_name === null ? null : replaceWordsInText(row.display_name, replaceWords),
        postCount: row.post_count,
        groupTitle: row.group_title,
        joinedAt: row.joined_at,
        avatarHash: row.avatar_hash,
        reputation: row.reputation,
        customTitle:
          row.custom_title === null ? null : replaceWordsInText(row.custom_title, replaceWords),
        rankTitle:
          row.rank_title_local === null || row.rank_title_local === ""
            ? null
            : row.rank_title_local,
        rankPips: row.rank_pips ?? 0,
        rankImageKey: row.rank_image_key,
        featuredBadges: badgesByMember.get(row.id) ?? [],
      },
    ]),
  );
}

export async function readPostContext(
  sql: SQL,
  postId: string,
): Promise<PostHistoryContext | null> {
  if (!/^\d+$/.test(postId)) {
    return null;
  }

  const rows = (await sql`
    SELECT
      p.id, p.topic_id, t.slug AS topic_slug, t.forum_id, p.author_id, p.body_md,
      p.body_html, p.visibility, p.created_at, p.edited_at,
      editor.display_name AS edited_by_name
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    LEFT JOIN core.members editor ON editor.id = p.edited_by
    WHERE p.id = ${postId}
  `) as Array<{
    id: string;
    topic_id: string;
    topic_slug: string;
    forum_id: string;
    author_id: string | null;
    body_md: string;
    body_html: string;
    visibility: TopicPostVisibility;
    created_at: Date;
    edited_at: Date | null;
    edited_by_name: string | null;
  }>;
  const row = rows[0];

  return row === undefined
    ? null
    : {
        id: row.id,
        topicId: row.topic_id,
        topicSlug: row.topic_slug,
        forumId: row.forum_id,
        authorId: row.author_id,
        bodyMd: row.body_md,
        bodyHtml: row.body_html,
        visibility: row.visibility,
        createdAt: row.created_at,
        editedAt: row.edited_at,
        editedByName: row.edited_by_name,
      };
}

export async function viewerCanReadPostHistory(
  sql: SQL,
  input: {
    readonly viewerId: string | null;
    readonly forumId: string;
    readonly tree: ForumTree;
    readonly publicHistory: boolean;
  },
): Promise<boolean> {
  if (input.publicHistory) {
    return true;
  }

  return (
    input.viewerId !== null &&
    (await can(sql, input.viewerId, "view_edit_history", {
      forumId: input.forumId,
      tree: input.tree,
    }))
  );
}

export async function readPostRevisions(
  sql: SQL,
  postId: string,
  includeProtected: boolean,
): Promise<readonly PostRevisionRow[]> {
  const rows = (await sql`
    SELECT
      r.id, r.body_md, r.body_html, r.editor_id, editor.display_name AS editor_name,
      r.edited_at, r.protected
    FROM core.post_revisions r
    LEFT JOIN core.members editor ON editor.id = r.editor_id
    WHERE r.post_id = ${postId}
      AND (${includeProtected} OR NOT r.protected)
    ORDER BY r.id
  `) as Array<{
    id: string;
    body_md: string;
    body_html: string;
    editor_id: string | null;
    editor_name: string | null;
    edited_at: Date;
    protected: boolean;
  }>;

  return rows.map((row) => ({
    id: row.id,
    bodyMd: row.body_md,
    bodyHtml: row.body_html,
    editorId: row.editor_id,
    editorName: row.editor_name,
    editedAt: row.edited_at,
    protected: row.protected,
  }));
}

/** Public history hides protected revisions; a moderator with view-history sees them all. */
export async function readPostHistory(
  sql: SQL,
  input: {
    readonly postId: string;
    readonly viewerId: string | null;
    readonly forumId: string;
    readonly tree: ForumTree;
    readonly publicHistory: boolean;
  },
): Promise<readonly PostRevisionRow[]> {
  const includeProtected =
    input.viewerId !== null &&
    (await can(sql, input.viewerId, "view_edit_history", {
      forumId: input.forumId,
      tree: input.tree,
    }));

  if (!input.publicHistory && !includeProtected) {
    return [];
  }

  return readPostRevisions(sql, input.postId, includeProtected);
}

/**
 * Topics newer than the member's topic, forum or board read watermark (ADR 0006). The caller
 * passes topic ids it has already authorised, so this never widens visibility.
 */
export async function unreadTopicIds(
  sql: SQL,
  input: { readonly memberId: string; readonly topicIds: readonly string[] },
): Promise<readonly string[]> {
  if (input.topicIds.length === 0) {
    return [];
  }

  const rows = (await sql`
    SELECT t.id::text AS id
    FROM core.topics t
    JOIN core.members m ON m.id = ${input.memberId}
    JOIN core.forums topic_forum ON topic_forum.id = t.forum_id
    LEFT JOIN core.topic_reads tr
      ON tr.member_id = m.id AND tr.topic_id = t.id
    LEFT JOIN LATERAL (
      SELECT max(fr.marked_at) AS marked_at
      FROM core.forum_reads fr
      JOIN core.forums marked ON marked.id = fr.forum_id
      WHERE fr.member_id = m.id AND topic_forum.path <@ marked.path
    ) fr ON true
    WHERE t.id = ANY(${`{${input.topicIds.join(",")}}`}::bigint[])
      AND t.last_post_at IS NOT NULL
      AND (
        date_trunc('milliseconds', t.last_post_at) > GREATEST(
          COALESCE(tr.last_read_at, 'epoch'::timestamptz),
          COALESCE(fr.marked_at, 'epoch'::timestamptz),
          COALESCE(m.board_marked_at, 'epoch'::timestamptz)
        )
        OR (
          date_trunc('milliseconds', t.last_post_at) = GREATEST(
            COALESCE(tr.last_read_at, 'epoch'::timestamptz),
            COALESCE(fr.marked_at, 'epoch'::timestamptz),
            COALESCE(m.board_marked_at, 'epoch'::timestamptz)
          )
          AND t.last_post_at > GREATEST(
            COALESCE(tr.last_read_at, 'epoch'::timestamptz),
            COALESCE(fr.marked_at, 'epoch'::timestamptz),
            COALESCE(m.board_marked_at, 'epoch'::timestamptz)
          )
          AND tr.last_read_post_id IS NOT NULL
          AND t.last_post_id > tr.last_read_post_id
        )
      )
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

export interface FirstUnreadPost {
  readonly topicId: string;
  readonly topicSlug: string;
  readonly postId: string;
  readonly page: number;
}

/** One row per member and forum; descendants inherit the mark through their ltree path. */
export async function markForumRead(
  sql: SQL,
  memberId: string,
  forumId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = (await sql`
    INSERT INTO core.forum_reads (member_id, forum_id, marked_at)
    SELECT ${memberId}, id, ${now}
    FROM core.forums
    WHERE id = ${forumId}
    ON CONFLICT (member_id, forum_id) DO UPDATE
      SET marked_at = GREATEST(core.forum_reads.marked_at, EXCLUDED.marked_at)
    RETURNING forum_id
  `) as unknown[];

  return rows.length > 0;
}

/** One member row; every forum and topic is read before this watermark. */
export async function markBoardRead(
  sql: SQL,
  memberId: string,
  now: Date = new Date(),
): Promise<void> {
  await sql`
    UPDATE core.members SET board_marked_at = GREATEST(COALESCE(board_marked_at, ${now}), ${now})
    WHERE id = ${memberId}
  `;
}

/**
 * First visible post after the member's effective watermark for each topic, with the page it
 * falls on. Used by the overlay's "first unread" links (task 5.1).
 */
export async function firstUnreadForTopics(
  sql: SQL,
  input: {
    readonly memberId: string;
    readonly topicIds: readonly string[];
    readonly perPage: number;
    readonly seeUnapproved?: boolean;
    readonly seeDeleted?: boolean;
  },
): Promise<readonly FirstUnreadPost[]> {
  if (input.topicIds.length === 0) {
    return [];
  }

  const rows = (await sql`
    WITH marked AS (
      SELECT
        t.id AS topic_id, t.slug AS topic_slug,
        GREATEST(
          COALESCE(tr.last_read_at, 'epoch'::timestamptz),
          COALESCE(fr.marked_at, 'epoch'::timestamptz),
          COALESCE(m.board_marked_at, 'epoch'::timestamptz)
        ) AS marker,
        tr.last_read_post_id
      FROM core.topics t
      JOIN core.members m ON m.id = ${input.memberId}
      JOIN core.forums topic_forum ON topic_forum.id = t.forum_id
      LEFT JOIN core.topic_reads tr
        ON tr.member_id = m.id AND tr.topic_id = t.id
      LEFT JOIN LATERAL (
        SELECT max(fr.marked_at) AS marked_at
        FROM core.forum_reads fr
        JOIN core.forums marked ON marked.id = fr.forum_id
        WHERE fr.member_id = m.id AND topic_forum.path <@ marked.path
      ) fr ON true
      WHERE t.id = ANY(${`{${input.topicIds.join(",")}}`}::bigint[])
    ),
    ranked AS (
      SELECT
        p.topic_id, p.id, p.position, marked.topic_slug,
        row_number() OVER (PARTITION BY p.topic_id ORDER BY p.position) AS rank
      FROM core.posts p
      JOIN marked ON marked.topic_id = p.topic_id
      WHERE (
          p.visibility = 'visible'
          OR (${input.seeUnapproved ?? false} AND p.visibility = 'unapproved')
          OR (${input.seeDeleted ?? false} AND p.visibility = 'soft_deleted')
        )
        AND (
          marked.marker = 'epoch'::timestamptz
          OR date_trunc('milliseconds', p.created_at) > marked.marker
          OR (
            date_trunc('milliseconds', p.created_at) = marked.marker
            AND p.created_at > marked.marker
            AND marked.last_read_post_id IS NOT NULL
            AND p.id > marked.last_read_post_id
          )
        )
    )
    SELECT
      ranked.topic_id::text AS topic_id,
      ranked.topic_slug,
      ranked.id::text AS post_id,
      ranked.position,
      (
        SELECT count(*)::int
        FROM core.posts p2
        WHERE p2.topic_id = ranked.topic_id
          AND (
            p2.visibility = 'visible'
            OR (${input.seeUnapproved ?? false} AND p2.visibility = 'unapproved')
            OR (${input.seeDeleted ?? false} AND p2.visibility = 'soft_deleted')
          )
          AND p2.position < ranked.position
      ) AS before
    FROM ranked
    WHERE ranked.rank = 1
    ORDER BY ranked.topic_id
  `) as Array<{
    topic_id: string;
    topic_slug: string;
    post_id: string;
    position: number;
    before: number;
  }>;

  return rows.map((row) => ({
    topicId: row.topic_id,
    topicSlug: row.topic_slug,
    postId: row.post_id,
    page: Math.floor(row.before / input.perPage) + 1,
  }));
}

/**
 * Forums (including ancestors) whose visible topics contain a post newer than the member's
 * effective watermark. Unread topics are found in every descendant of the requested forums
 * that the member can read, then aggregated onto the requested ancestors: a category must show
 * unread when only a grandchild has new posts (reviewer finding), and a descendant the member
 * cannot read never marks anything.
 */
export async function unreadForumIds(
  sql: SQL,
  input: {
    readonly memberId: string;
    readonly forumIds: readonly string[];
    readonly sessionId?: string | null;
    /** Reuse the caller's permission context instead of loading it again. */
    readonly tree?: ForumTree;
    readonly snapshot?: PermissionSnapshot;
  },
): Promise<readonly string[]> {
  if (input.forumIds.length === 0) {
    return [];
  }

  const tree = input.tree ?? (await loadForumTree(sql));
  const snapshot =
    input.snapshot ??
    (await loadPermissionSnapshot(sql, input.memberId, {
      tree,
      sessionId: input.sessionId ?? null,
    }));
  const candidates = new Set<string>();

  for (const forumId of input.forumIds) {
    if (tree.get(forumId) === undefined) {
      continue;
    }

    candidates.add(forumId);

    for (const descendant of tree.descendants(forumId)) {
      candidates.add(descendant.id);
    }
  }

  const readable: string[] = [];

  for (const forumId of candidates) {
    if (await can(sql, input.memberId, "read", { forumId, tree, snapshot })) {
      readable.push(forumId);
    }
  }

  if (readable.length === 0) {
    return [];
  }

  const rows = (await sql`
    WITH unread AS (
      SELECT DISTINCT t.forum_id
      FROM core.topics t
      JOIN core.members m ON m.id = ${input.memberId}
      JOIN core.forums topic_forum ON topic_forum.id = t.forum_id
      LEFT JOIN core.topic_reads tr
        ON tr.member_id = m.id AND tr.topic_id = t.id
      LEFT JOIN LATERAL (
        SELECT max(fr.marked_at) AS marked_at
        FROM core.forum_reads fr
        JOIN core.forums marked ON marked.id = fr.forum_id
        WHERE fr.member_id = m.id AND topic_forum.path <@ marked.path
      ) fr ON true
      WHERE t.forum_id = ANY(${`{${readable.join(",")}}`}::bigint[])
        AND t.last_post_at IS NOT NULL
        AND (
          date_trunc('milliseconds', t.last_post_at) > GREATEST(
            COALESCE(tr.last_read_at, 'epoch'::timestamptz),
            COALESCE(fr.marked_at, 'epoch'::timestamptz),
            COALESCE(m.board_marked_at, 'epoch'::timestamptz)
          )
          OR (
            date_trunc('milliseconds', t.last_post_at) = GREATEST(
              COALESCE(tr.last_read_at, 'epoch'::timestamptz),
              COALESCE(fr.marked_at, 'epoch'::timestamptz),
              COALESCE(m.board_marked_at, 'epoch'::timestamptz)
            )
            AND t.last_post_at > GREATEST(
              COALESCE(tr.last_read_at, 'epoch'::timestamptz),
              COALESCE(fr.marked_at, 'epoch'::timestamptz),
              COALESCE(m.board_marked_at, 'epoch'::timestamptz)
            )
            AND tr.last_read_post_id IS NOT NULL
            AND t.last_post_id > tr.last_read_post_id
          )
        )
    )
    SELECT DISTINCT forum.id::text AS id
    FROM core.forums forum
    WHERE forum.id = ANY(${`{${input.forumIds.join(",")}}`}::bigint[])
      AND EXISTS (
        SELECT 1
        FROM unread
        JOIN core.forums topic_forum ON topic_forum.id = unread.forum_id
        WHERE topic_forum.path <@ forum.path
      )
    ORDER BY forum.id::text
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

/**
 * Folds buffered views into `core.topics.view_count` (ADR 0006). It never bumps `topic:{id}`:
 * the separate views fragment has a 60 s TTL. The delete and the counter update share one
 * transaction so a crash cannot count a bucket twice.
 */
export async function flushTopicViews(sql: SQL): Promise<number> {
  const rows = (await sql`
    WITH claimed AS (
      UPDATE core.topic_view_buffer
      SET flushed_at = now()
      WHERE flushed_at IS NULL
      RETURNING topic_id
    ),
    counts AS (
      SELECT topic_id, count(*)::int AS count
      FROM claimed
      GROUP BY topic_id
    ),
    updated AS (
      UPDATE core.topics t
      SET view_count = t.view_count + counts.count
      FROM counts
      WHERE t.id = counts.topic_id
      RETURNING 1
    )
    SELECT coalesce(sum(counts.count), 0)::int AS count, (SELECT count(*) FROM updated) AS topics
    FROM counts
  `) as Array<{ count: number }>;

  return rows[0]?.count ?? 0;
}

/** Removes redirect stubs whose chosen lifetime has elapsed (ADR 0001). */
export async function purgeExpiredTopicStubs(sql: SQL, now: Date = new Date()): Promise<number> {
  const rows = (await sql`
    DELETE FROM core.topics
    WHERE moved_to IS NOT NULL AND stub_expires_at <= ${now}
    RETURNING 1
  `) as unknown[];

  return rows.length;
}

/** Visible post ids after a stream cursor, oldest first (capped at the replay limit + 1). */
export async function visiblePostIdsAfter(
  sql: SQL,
  topicId: string,
  afterId: bigint,
  limit: number,
): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT id::text AS id
    FROM core.posts
    WHERE topic_id = ${topicId}
      AND visibility = 'visible'
      AND id > ${afterId}
    ORDER BY id
    LIMIT ${limit}
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

export interface ReplayGap {
  readonly missed: number;
  readonly oldest: Date | null;
}

/** What a disconnect missed in one topic, for the stream's replay-or-resync decision. */
export async function postReplayGap(
  sql: SQL,
  topicId: string,
  afterId: bigint,
): Promise<ReplayGap> {
  const [row] = (await sql`
    SELECT count(*)::int AS missed, min(created_at) AS oldest
    FROM core.posts
    WHERE topic_id = ${topicId} AND visibility = 'visible' AND id > ${afterId}
  `) as Array<{ missed: number; oldest: Date | string | null }>;

  return {
    missed: row?.missed ?? 0,
    oldest: row?.oldest === null || row?.oldest === undefined ? null : new Date(row.oldest),
  };
}
