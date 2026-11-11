import type { SQL } from "bun";
import { can } from "../permissions/can.ts";
import type { ViewerPrincipal } from "../permissions/principal.ts";
import { loadMergedGroupSettings } from "../permissions/store.ts";
import { loadForumTree } from "../permissions/tree-store.ts";

/** One staff-defined reaction (design: `reactions(id, icon, label_key, weight, …)`). */
export interface ReactionRecord {
  readonly id: string;
  readonly key: string;
  readonly icon: string;
  readonly labelKey: string;
  readonly weight: -1 | 0 | 1;
  readonly position: number;
  readonly enabled: boolean;
}

/** Reaction id to total, as stored in `posts.reaction_summary`. */
export type ReactionSummary = Readonly<Record<string, number>>;

export interface ReactionTarget {
  readonly postId: string;
  readonly topicId: string;
  readonly forumId: string;
  readonly authorId: string | null;
  readonly visibility: "visible" | "unapproved" | "soft_deleted";
}

export interface ReactionMember {
  readonly id: string;
  readonly displayName: string | null;
}

/** The viewer-specific state the overlay applies to the shared reaction bar (ADR 0006). */
export interface ViewerReaction {
  readonly postId: string;
  readonly reactionId: string | null;
  /** The viewer wrote this post; the bar hides its picker instead of offering a rejection. */
  readonly own: boolean;
}

interface ReactionRow {
  readonly id: string;
  readonly key: string;
  readonly icon: string;
  readonly label_key: string;
  readonly weight: number;
  readonly position: number;
  readonly enabled: boolean;
}

function weight(value: number): -1 | 0 | 1 {
  return value === 1 ? 1 : value === -1 ? -1 : 0;
}

function record(row: ReactionRow): ReactionRecord {
  return {
    id: row.id,
    key: row.key,
    icon: row.icon,
    labelKey: row.label_key,
    weight: weight(row.weight),
    position: row.position,
    enabled: row.enabled,
  };
}

/** The whole set in display order; disabled reactions stay visible for their existing counts. */
export async function listReactions(sql: SQL): Promise<readonly ReactionRecord[]> {
  const rows = (await sql`
    SELECT id::text AS id, key, icon, label_key, weight, position, enabled
    FROM core.reactions
    ORDER BY position, id
  `) as ReactionRow[];

  return rows.map(record);
}

export async function readReaction(sql: SQL, reactionId: string): Promise<ReactionRecord | null> {
  if (!/^\d+$/.test(reactionId)) {
    return null;
  }

  const [row] = (await sql`
    SELECT id::text AS id, key, icon, label_key, weight, position, enabled
    FROM core.reactions
    WHERE id = ${reactionId}
  `) as ReactionRow[];

  return row === undefined ? null : record(row);
}

/** Parses the denormalised summary; unknown shapes degrade to no totals, never an error. */
export function parseReactionSummary(value: unknown): ReactionSummary {
  let parsed = value;

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return {};
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const summary: Record<string, number> = {};

  for (const [reactionId, count] of Object.entries(parsed)) {
    if (/^\d+$/.test(reactionId) && typeof count === "number" && count > 0) {
      summary[reactionId] = count;
    }
  }

  return summary;
}

/** Serialises reaction writes on one post so concurrent summaries cannot lose an update. */
export async function lockReactionPost(tx: SQL, postId: string): Promise<void> {
  await tx`SELECT id FROM core.posts WHERE id = ${postId} FOR UPDATE`;
}

/** Recomputes `posts.reaction_summary` in the caller's transaction and returns the new totals. */
export async function recomputeReactionSummary(tx: SQL, postId: string): Promise<ReactionSummary> {
  const rows = (await tx`
    UPDATE core.posts p
    SET reaction_summary = COALESCE(
      (
        SELECT jsonb_object_agg(tally.reaction_id::text, tally.total)
        FROM (
          SELECT reaction_id, count(*)::int AS total
          FROM core.post_reactions
          WHERE post_id = ${postId}
          GROUP BY reaction_id
        ) tally
      ),
      '{}'::jsonb
    )
    WHERE p.id = ${postId}
    RETURNING reaction_summary
  `) as Array<{ reaction_summary: unknown }>;

  return parseReactionSummary(rows[0]?.reaction_summary);
}

export async function readReactionSummary(sql: SQL, postId: string): Promise<ReactionSummary> {
  const [row] = (await sql`
    SELECT reaction_summary FROM core.posts WHERE id = ${postId}
  `) as Array<{ reaction_summary: unknown }>;

  return parseReactionSummary(row?.reaction_summary);
}

export async function readReactionTarget(sql: SQL, postId: string): Promise<ReactionTarget | null> {
  if (!/^\d+$/.test(postId)) {
    return null;
  }

  const [row] = (await sql`
    SELECT p.id::text AS id, p.topic_id::text AS topic_id, t.forum_id::text AS forum_id,
      p.author_id::text AS author_id, p.visibility
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ${postId}
  `) as Array<{
    id: string;
    topic_id: string;
    forum_id: string;
    author_id: string | null;
    visibility: ReactionTarget["visibility"];
  }>;

  return row === undefined
    ? null
    : {
        postId: row.id,
        topicId: row.topic_id,
        forumId: row.forum_id,
        authorId: row.author_id,
        visibility: row.visibility,
      };
}

/** Who picked one reaction, newest first. Someone the reader can read the post. */
export async function readReactors(
  sql: SQL,
  postId: string,
  reactionId: string,
  limit = 100,
): Promise<readonly ReactionMember[]> {
  const rows = (await sql`
    SELECT m.id::text AS id, m.display_name
    FROM core.post_reactions pr
    JOIN core.members m ON m.id = pr.member_id
    WHERE pr.post_id = ${postId} AND pr.reaction_id = ${reactionId}
    ORDER BY pr.created_at DESC, m.id DESC
    LIMIT ${limit}
  `) as Array<{ id: string; display_name: string | null }>;

  return rows.map((row) => ({ id: row.id, displayName: row.display_name }));
}

/** One member's reaction on one post, for the mutation's no-op fast path. */
export async function readMemberReaction(
  sql: SQL,
  postId: string,
  memberId: string,
): Promise<string | null> {
  const [row] = (await sql`
    SELECT reaction_id::text AS reaction_id
    FROM core.post_reactions
    WHERE post_id = ${postId} AND member_id = ${memberId}
  `) as Array<{ reaction_id: string }>;

  return row?.reaction_id ?? null;
}

/** The member's own reaction and authorship for the posts an overlay request named. */
export async function readViewerReactions(
  sql: SQL,
  memberId: string,
  postIds: readonly string[],
): Promise<readonly ViewerReaction[]> {
  const ids = [...new Set(postIds.filter((id) => /^\d+$/.test(id)))];

  if (ids.length === 0) {
    return [];
  }

  const rows = (await sql`
    SELECT p.id::text AS id, p.author_id::text AS author_id, pr.reaction_id::text AS reaction_id
    FROM core.posts p
    LEFT JOIN core.post_reactions pr ON pr.post_id = p.id AND pr.member_id = ${memberId}
    WHERE p.id = ANY(${`{${ids.join(",")}}`}::bigint[])
  `) as Array<{ id: string; author_id: string | null; reaction_id: string | null }>;

  return rows.map((row) => ({
    postId: row.id,
    reactionId: row.reaction_id,
    own: row.author_id === memberId,
  }));
}

/** Whether the viewer's groups allow reacting and the post's forum is readable. */
export async function canReactInForum(
  sql: SQL,
  principal: ViewerPrincipal,
  forumId: string,
  sessionId: string | null = null,
): Promise<boolean> {
  const [tree, settings] = await Promise.all([
    loadForumTree(sql),
    loadMergedGroupSettings(sql, principal),
  ]);

  return (
    settings["posting.can_react"] === true &&
    (await can(sql, principal, "read", { forumId, tree, sessionId }))
  );
}
