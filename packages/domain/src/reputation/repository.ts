import type { SQL } from "bun";
import { can } from "../permissions/can.ts";
import { loadMergedGroupSettings } from "../permissions/store.ts";
import { loadForumTree } from "../permissions/tree-store.ts";

export type ReputationSource = "vote" | "reaction";

export interface ReputationTarget {
  readonly postId: string;
  readonly topicId: string;
  readonly forumId: string;
  readonly authorId: string | null;
  readonly visibility: "visible" | "unapproved" | "soft_deleted";
}

export interface ReputationEntryRecord {
  readonly id: string;
  readonly postId: string;
  readonly topicId: string;
  readonly topicTitle: string;
  readonly giverId: string | null;
  readonly giverName: string | null;
  readonly receiverId: string;
  readonly points: number;
  readonly source: ReputationSource;
  readonly createdAt: Date;
}

/** The viewer's own vote on a post, for the personal overlay (ADR 0006). */
export interface ViewerVote {
  readonly postId: string;
  readonly points: number | null;
  /** The viewer wrote the post; giving reputation to it is refused. */
  readonly own: boolean;
}

export interface ReputationRules {
  readonly canGive: boolean;
  readonly canGiveNegative: boolean;
  readonly minPosts: number;
  readonly dailyLimit: number;
}

export interface DailyUsage {
  readonly used: number;
  /** The next midnight in the board's timezone (the database session timezone). */
  readonly resetsAt: Date;
}

interface EntryRow {
  readonly id: string;
  readonly post_id: string;
  readonly topic_id: string;
  readonly topic_title: string;
  readonly giver_id: string | null;
  readonly giver_name: string | null;
  readonly receiver_id: string;
  readonly points: number;
  readonly source: ReputationSource;
  readonly created_at: Date;
}

function entry(row: EntryRow): ReputationEntryRecord {
  return {
    id: row.id,
    postId: row.post_id,
    topicId: row.topic_id,
    topicTitle: row.topic_title,
    giverId: row.giver_id,
    giverName: row.giver_name,
    receiverId: row.receiver_id,
    points: row.points,
    source: row.source,
    createdAt: row.created_at,
  };
}

export async function readReputationTarget(
  sql: SQL,
  postId: string,
): Promise<ReputationTarget | null> {
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
    visibility: ReputationTarget["visibility"];
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

export async function canReadPost(
  sql: SQL,
  principal: string,
  forumId: string,
  sessionId: string | null = null,
): Promise<boolean> {
  const tree = await loadForumTree(sql);
  return can(sql, principal, "read", { forumId, tree, sessionId });
}

/** Whether the member may give, give negative points and how many may be given per day. */
export async function readReputationRules(sql: SQL, memberId: string): Promise<ReputationRules> {
  const settings = await loadMergedGroupSettings(sql, memberId);
  const minPosts = Number(settings["posting.reputation_min_posts"] ?? 0);
  const dailyLimit = Number(settings["posting.reputation_daily_limit"] ?? 10);

  return {
    canGive: settings["posting.can_give_reputation"] === true,
    canGiveNegative: settings["posting.can_give_negative_reputation"] === true,
    minPosts: Number.isFinite(minPosts) ? minPosts : 0,
    dailyLimit: Number.isFinite(dailyLimit) ? dailyLimit : 10,
  };
}

/** A `restrict-any` opt-out: one group can stop a member from receiving reputation. */
export async function canReceiveReputation(sql: SQL, memberId: string): Promise<boolean> {
  const settings = await loadMergedGroupSettings(sql, memberId);
  return settings["posting.cannot_receive_reputation"] !== true;
}

export async function readDailyUsage(sql: SQL, giverId: string): Promise<DailyUsage> {
  const [row] = (await sql`
    SELECT
      count(*)::int AS used,
      date_trunc('day', now()) + interval '1 day' AS resets_at
    FROM core.reputation_entries
    WHERE giver_id = ${giverId}
      AND source = 'vote'
      AND created_at >= date_trunc('day', now())
  `) as Array<{ used: number; resets_at: Date }>;

  return { used: row?.used ?? 0, resetsAt: row?.resets_at ?? new Date() };
}

export async function memberReputation(sql: SQL, memberId: string): Promise<number> {
  const [row] = (await sql`
    SELECT reputation FROM core.members WHERE id = ${memberId}
  `) as Array<{ reputation: number }>;

  return row?.reputation ?? 0;
}

export async function memberPostCount(sql: SQL, memberId: string): Promise<number> {
  const [row] = (await sql`
    SELECT post_count FROM core.members WHERE id = ${memberId}
  `) as Array<{ post_count: number }>;

  return row?.post_count ?? 0;
}

/** Serialises giving on one post; the receiver's total update is atomic on its own row. */
export async function lockReputationPost(tx: SQL, postId: string): Promise<void> {
  await tx`SELECT id FROM core.posts WHERE id = ${postId} FOR UPDATE`;
}

/** Drops reaction entries whose reaction vanished, lost its weight or no longer counts. */
export async function deleteStaleReactionEntries(tx: SQL): Promise<void> {
  await tx`
    DELETE FROM core.reputation_entries e
    WHERE e.source = 'reaction'
      AND NOT EXISTS (
        SELECT 1
        FROM core.post_reactions pr
        JOIN core.reactions r ON r.id = pr.reaction_id
        JOIN core.posts p ON p.id = pr.post_id
        WHERE pr.post_id = e.post_id
          AND pr.member_id = e.giver_id
          AND r.weight <> 0
          AND p.author_id = e.receiver_id
      )
  `;
}

/** Rebuilds reaction entries from the current reactions, skipping opted-out receivers. */
export async function upsertReactionEntries(tx: SQL): Promise<void> {
  await tx`
    INSERT INTO core.reputation_entries (post_id, giver_id, receiver_id, points, source)
    SELECT pr.post_id, pr.member_id, p.author_id, r.weight, 'reaction'
    FROM core.post_reactions pr
    JOIN core.reactions r ON r.id = pr.reaction_id
    JOIN core.posts p ON p.id = pr.post_id
    WHERE r.weight <> 0
      AND p.author_id IS NOT NULL
      AND p.author_id <> pr.member_id
      AND NOT EXISTS (
        SELECT 1
        FROM core.member_groups mg
        JOIN core.group_settings gs ON gs.group_id = mg.group_id
        WHERE mg.member_id = p.author_id
          AND gs.key = 'posting.cannot_receive_reputation'
          AND gs.value = 'true'::jsonb
      )
    ON CONFLICT (post_id, giver_id, source) DO UPDATE
      SET points = EXCLUDED.points, receiver_id = EXCLUDED.receiver_id
  `;
}

/** Removes every reaction-sourced entry (the link is off). */
export async function deleteReactionEntries(tx: SQL): Promise<void> {
  await tx`DELETE FROM core.reputation_entries WHERE source = 'reaction'`;
}

/** Locks the member row; two giving transactions for the same receiver cannot interleave. */
export async function lockMember(tx: SQL, memberId: string): Promise<void> {
  await tx`SELECT id FROM core.members WHERE id = ${memberId} FOR UPDATE`;
}

export async function readVoteEntry(
  sql: SQL,
  postId: string,
  giverId: string,
): Promise<{ readonly id: string; readonly points: number } | null> {
  const [row] = (await sql`
    SELECT id::text AS id, points
    FROM core.reputation_entries
    WHERE post_id = ${postId} AND giver_id = ${giverId} AND source = 'vote'
  `) as Array<{ id: string; points: number }>;

  return row ?? null;
}

export async function readReactionEntry(
  sql: SQL,
  postId: string,
  giverId: string,
): Promise<{ readonly id: string; readonly points: number } | null> {
  const [row] = (await sql`
    SELECT id::text AS id, points
    FROM core.reputation_entries
    WHERE post_id = ${postId} AND giver_id = ${giverId} AND source = 'reaction'
  `) as Array<{ id: string; points: number }>;

  return row ?? null;
}

/** The viewer's vote and authorship for the posts the overlay request named. */
export async function readViewerVotes(
  sql: SQL,
  memberId: string,
  postIds: readonly string[],
): Promise<readonly ViewerVote[]> {
  const ids = [...new Set(postIds.filter((id) => /^\d+$/.test(id)))];

  if (ids.length === 0) {
    return [];
  }

  const rows = (await sql`
    SELECT p.id::text AS id, p.author_id::text AS author_id, e.points
    FROM core.posts p
    LEFT JOIN core.reputation_entries e
      ON e.post_id = p.id AND e.giver_id = ${memberId} AND e.source = 'vote'
    WHERE p.id = ANY(${`{${ids.join(",")}}`}::bigint[])
  `) as Array<{ id: string; author_id: string | null; points: number | null }>;

  return rows.map((row) => ({
    postId: row.id,
    points: row.points,
    own: row.author_id === memberId,
  }));
}

/** One member's reputation entries for the staff tools, newest first. */
export async function listReputationEntries(
  sql: SQL,
  memberId: string,
  limit = 100,
): Promise<readonly ReputationEntryRecord[]> {
  const rows = (await sql`
    SELECT
      e.id::text AS id,
      e.post_id::text AS post_id,
      p.topic_id::text AS topic_id,
      t.title AS topic_title,
      e.giver_id::text AS giver_id,
      g.display_name AS giver_name,
      e.receiver_id::text AS receiver_id,
      e.points,
      e.source,
      e.created_at
    FROM core.reputation_entries e
    JOIN core.posts p ON p.id = e.post_id
    JOIN core.topics t ON t.id = p.topic_id
    LEFT JOIN core.members g ON g.id = e.giver_id
    WHERE e.receiver_id = ${memberId}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${limit}
  `) as EntryRow[];

  return rows.map(entry);
}

export async function readEntry(sql: SQL, entryId: string): Promise<ReputationEntryRecord | null> {
  const [row] = (await sql`
    SELECT
      e.id::text AS id,
      e.post_id::text AS post_id,
      p.topic_id::text AS topic_id,
      t.title AS topic_title,
      e.giver_id::text AS giver_id,
      g.display_name AS giver_name,
      e.receiver_id::text AS receiver_id,
      e.points,
      e.source,
      e.created_at
    FROM core.reputation_entries e
    JOIN core.posts p ON p.id = e.post_id
    JOIN core.topics t ON t.id = p.topic_id
    LEFT JOIN core.members g ON g.id = e.giver_id
    WHERE e.id = ${entryId}
  `) as EntryRow[];

  return row === undefined ? null : entry(row);
}

/** Applies one entry delta to the denormalised total and returns the new value. */
export async function addToReputation(tx: SQL, memberId: string, delta: number): Promise<number> {
  const [row] = (await tx`
    UPDATE core.members
    SET reputation = reputation + ${delta}
    WHERE id = ${memberId}
    RETURNING reputation
  `) as Array<{ reputation: number }>;

  if (row === undefined) {
    throw new Error(`Could not update the reputation of member ${memberId}`);
  }

  return row.reputation;
}

/** Recomputes a member's total from the entries; the recount path for staff and jobs. */
export async function recomputeReputation(
  tx: SQL,
  memberId: string,
): Promise<{ readonly previous: number; readonly total: number } | null> {
  const [before] = (await tx`
    SELECT reputation FROM core.members WHERE id = ${memberId} FOR UPDATE
  `) as Array<{ reputation: number }>;

  if (before === undefined) {
    return null;
  }

  const [row] = (await tx`
    UPDATE core.members m
    SET reputation = COALESCE(
      (SELECT sum(e.points)::int FROM core.reputation_entries e WHERE e.receiver_id = m.id),
      0
    )
    WHERE m.id = ${memberId}
    RETURNING m.reputation
  `) as Array<{ reputation: number }>;

  return { previous: before.reputation, total: row?.reputation ?? before.reputation };
}

/** Recomputes every member's total; used after a board-wide reaction-link change. */
export async function recomputeAllReputations(
  tx: SQL,
): Promise<
  readonly { readonly memberId: string; readonly previous: number; readonly total: number }[]
> {
  const rows = (await tx`
    WITH before AS (
      SELECT id, reputation AS previous FROM core.members
    ),
    updated AS (
      UPDATE core.members m
      SET reputation = COALESCE(
        (SELECT sum(e.points)::int FROM core.reputation_entries e WHERE e.receiver_id = m.id),
        0
      )
      RETURNING m.id, m.reputation AS total
    )
    SELECT u.id::text AS member_id, b.previous, u.total
    FROM updated u
    JOIN before b ON b.id = u.id
    WHERE u.total <> b.previous
    ORDER BY u.id
  `) as Array<{ member_id: string; previous: number; total: number }>;

  return rows.map((row) => ({
    memberId: row.member_id,
    previous: row.previous,
    total: row.total,
  }));
}
