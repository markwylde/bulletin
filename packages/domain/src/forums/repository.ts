import type { SQL } from "bun";
import type { CapabilityView } from "../permissions/capability.ts";

export const FORUM_TYPES = ["category", "forum", "redirect"] as const;
export type ForumType = (typeof FORUM_TYPES)[number];

export const FORUM_DEFAULT_SORTS = ["last_post", "start_date", "title"] as const;
export type ForumDefaultSort = (typeof FORUM_DEFAULT_SORTS)[number];

export const FORUM_PREFIX_MODES = ["none", "optional", "required"] as const;
export type ForumPrefixMode = (typeof FORUM_PREFIX_MODES)[number];

/**
 * One category or forum as the reading layer needs it. `path` is the materialised `ltree`
 * rendered as text; the permission compiler builds its own lighter tree from the same rows.
 * IDs are strings because Postgres `bigint` values are read as strings (ADR 0001).
 */
export interface ForumRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly path: string;
  readonly type: ForumType;
  readonly title: string;
  readonly slug: string;
  readonly position: number;
  readonly description: string;
  readonly rules: string;
  readonly passwordProtected: boolean;
  readonly redirectUrl: string | null;
  readonly redirectClicks: number;
  readonly showModerators: boolean;
  readonly defaultSort: ForumDefaultSort;
  readonly language: string | null;
  readonly prefixMode: ForumPrefixMode;
  readonly topicCount: number;
  readonly postCount: number;
  readonly lastTopicId: string | null;
  readonly lastPostId: string | null;
  readonly lastPostMemberId: string | null;
  readonly lastPostAt: Date | null;
}

export type VisibleForum = ForumRecord;

interface ForumRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly path: string;
  readonly type: ForumType;
  readonly title: string;
  readonly slug: string;
  readonly position: number;
  readonly description: string;
  readonly rules: string;
  readonly password_protected: boolean;
  readonly redirect_url: string | null;
  readonly redirect_clicks: string;
  readonly show_moderators: boolean;
  readonly default_sort: ForumDefaultSort;
  readonly language: string | null;
  readonly prefix_mode: ForumPrefixMode;
  readonly topic_count: number;
  readonly post_count: number;
  readonly last_topic_id: string | null;
  readonly last_post_id: string | null;
  readonly last_post_member_id: string | null;
  readonly last_post_at: Date | null;
}

function toForum(row: ForumRow): ForumRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    path: row.path,
    type: row.type,
    title: row.title,
    slug: row.slug,
    position: row.position,
    description: row.description,
    rules: row.rules,
    passwordProtected: row.password_protected,
    redirectUrl: row.redirect_url,
    redirectClicks: Number(row.redirect_clicks),
    showModerators: row.show_moderators,
    defaultSort: row.default_sort,
    language: row.language,
    prefixMode: row.prefix_mode,
    topicCount: row.topic_count,
    postCount: row.post_count,
    lastTopicId: row.last_topic_id,
    lastPostId: row.last_post_id,
    lastPostMemberId: row.last_post_member_id,
    lastPostAt: row.last_post_at,
  };
}

/**
 * The permission-filtered forum repository (ADR 0005). Every content query must live behind a
 * function that takes the viewer's capability accessor; the architecture test fails a build
 * that queries content tables anywhere else.
 */
export async function listVisibleForums(
  sql: SQL,
  capability: CapabilityView,
): Promise<readonly ForumRecord[]> {
  const rows = (await sql`
    SELECT
      id, parent_id, path::text AS path, type, title, slug, position, description, rules,
      (password_hash IS NOT NULL) AS password_protected, redirect_url,
      redirect_clicks::text AS redirect_clicks, show_moderators, default_sort, language,
      prefix_mode, topic_count, post_count, last_topic_id, last_post_id, last_post_member_id,
      last_post_at
    FROM core.forums
    ORDER BY path, position, id
  `) as ForumRow[];

  return rows.filter((row) => capability.has(row.id, "show")).map(toForum);
}

export async function readVisibleForum(
  sql: SQL,
  capability: CapabilityView,
  forumId: string,
): Promise<ForumRecord | null> {
  const rows = (await sql`
    SELECT
      id, parent_id, path::text AS path, type, title, slug, position, description, rules,
      (password_hash IS NOT NULL) AS password_protected, redirect_url,
      redirect_clicks::text AS redirect_clicks, show_moderators, default_sort, language,
      prefix_mode, topic_count, post_count, last_topic_id, last_post_id, last_post_member_id,
      last_post_at
    FROM core.forums
    WHERE id = ${forumId}
  `) as ForumRow[];

  const row = rows[0];

  if (row === undefined || !capability.read(row.id)) {
    return null;
  }

  return toForum(row);
}
