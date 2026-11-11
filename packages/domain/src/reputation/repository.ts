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
  readonly forumId: string;
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
  readonly forum_id: string;
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
    forumId: row.forum_id,
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

/** The authors of reacted posts: the only members a reaction entry can credit. */
export async function listReactionReceivers(tx: SQL): Promise<readonly string[]> {
  const rows = (await tx`
    SELECT DISTINCT p.author_id::text AS id
    FROM core.post_reactions pr
    JOIN core.reactions r ON r.id = pr.reaction_id
    JOIN core.posts p ON p.id = pr.post_id
    WHERE r.weight <> 0
      AND p.author_id IS NOT NULL
      AND p.author_id <> pr.member_id
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

/** Drops reaction entries whose reaction vanished, lost its weight or targets an opt-out. */
export async function deleteStaleReactionEntries(
  tx: SQL,
  allowedReceiverIds: readonly string[],
): Promise<void> {
  const allowed = `{${allowedReceiverIds.join(",")}}`;

  await tx`
    DELETE FROM core.reputation_entries e
    WHERE e.source = 'reaction'
      AND (
        NOT (e.receiver_id = ANY(${allowed}::bigint[]))
        OR NOT EXISTS (
          SELECT 1
          FROM core.post_reactions pr
          JOIN core.reactions r ON r.id = pr.reaction_id
          JOIN core.posts p ON p.id = pr.post_id
          WHERE pr.post_id = e.post_id
            AND pr.member_id = e.giver_id
            AND r.weight <> 0
            AND p.author_id = e.receiver_id
        )
      )
  `;
}

/** Rebuilds reaction entries for the receivers that may still receive reputation. */
export async function upsertReactionEntries(
  tx: SQL,
  allowedReceiverIds: readonly string[],
): Promise<void> {
  const allowed = `{${allowedReceiverIds.join(",")}}`;

  await tx`
    INSERT INTO core.reputation_entries (post_id, giver_id, receiver_id, points, source)
    SELECT pr.post_id, pr.member_id, p.author_id, r.weight, 'reaction'
    FROM core.post_reactions pr
    JOIN core.reactions r ON r.id = pr.reaction_id
    JOIN core.posts p ON p.id = pr.post_id
    WHERE r.weight <> 0
      AND p.author_id IS NOT NULL
      AND p.author_id <> pr.member_id
      AND p.author_id = ANY(${allowed}::bigint[])
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
      t.forum_id::text AS forum_id,
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
      t.forum_id::text AS forum_id,
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
/** One member's total, recomputed after locking the row (the caller's transaction). */
export async function recomputeReputation(
  tx: SQL,
  memberId: string,
): Promise<{ readonly previous: number; readonly total: number } | null> {
  const changed = await recomputeMemberBatch(tx, [memberId]);

  if (changed.length > 0) {
    const [entry] = changed;
    return entry === undefined ? null : { previous: entry.previous, total: entry.total };
  }

  const [row] = (await tx`
    SELECT reputation FROM core.members WHERE id = ${memberId}
  `) as Array<{ reputation: number }>;

  return row === undefined ? null : { previous: row.reputation, total: row.reputation };
}

export interface MemberTotalChange {
  readonly memberId: string;
  readonly previous: number;
  readonly total: number;
}

/**
 * Recomputes a batch of totals after locking every row first. The lock statement waits for an
 * in-flight vote and the following UPDATE takes a fresh snapshot, so a committed vote can never
 * be missed (ADR 0006 consistency for materialisations).
 */
export async function recomputeMemberBatch(
  tx: SQL,
  memberIds: readonly string[],
): Promise<readonly MemberTotalChange[]> {
  if (memberIds.length === 0) {
    return [];
  }

  const ids = `{${memberIds.join(",")}}`;
  const before = (await tx`
    SELECT id::text AS id, reputation AS previous
    FROM core.members
    WHERE id = ANY(${ids}::bigint[])
    ORDER BY core.members.id
    FOR UPDATE
  `) as Array<{ id: string; previous: number }>;
  const previousById = new Map(before.map((row) => [row.id, row.previous]));
  const updated = (await tx`
    UPDATE core.members m
    SET reputation = COALESCE(
      (SELECT sum(e.points)::int FROM core.reputation_entries e WHERE e.receiver_id = m.id),
      0
    )
    WHERE m.id = ANY(${ids}::bigint[])
    RETURNING m.id::text AS id, m.reputation AS total
  `) as Array<{ id: string; total: number }>;

  return updated
    .map((row) => ({
      memberId: row.id,
      previous: previousById.get(row.id) ?? 0,
      total: row.total,
    }))
    .filter((row) => row.previous !== row.total)
    .sort((left, right) => (BigInt(left.memberId) < BigInt(right.memberId) ? -1 : 1));
}

/** Member ids after the cursor, in id order, for a resumable recount batch. */
export async function nextMemberBatch(
  tx: SQL,
  cursorMemberId: string,
  limit: number,
): Promise<readonly string[]> {
  const rows = (await tx`
    SELECT id::text AS id
    FROM core.members
    WHERE id > ${cursorMemberId}::bigint
    ORDER BY core.members.id
    LIMIT ${limit}
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

/** Recomputes every member's total in id-ordered batches, locking each batch before its sum. */
export async function recomputeAllReputations(tx: SQL): Promise<readonly MemberTotalChange[]> {
  const changed: MemberTotalChange[] = [];
  let cursor = "0";

  for (;;) {
    const ids = await nextMemberBatch(tx, cursor, 250);

    if (ids.length === 0) {
      break;
    }

    changed.push(...(await recomputeMemberBatch(tx, ids)));
    cursor = ids[ids.length - 1] ?? cursor;
  }

  return changed;
}

// ---------------------------------------------------------------------------------------------
// Board recounts: resumable runs with progress for the staff app (design risk: big boards)
// ---------------------------------------------------------------------------------------------

const RECOUNT_CLAIM_LOCK = "bulletin.reputation.recount";
const REBUILD_LOCK = "bulletin.reputation.rebuild";

/**
 * Coordinates the reaction-entry rebuild with reaction writers: the rebuild takes it
 * exclusively, and a reaction mutation takes it shared, so no write straddles the rebuild.
 */
export async function lockReputationRebuild(tx: SQL, mode: "shared" | "exclusive"): Promise<void> {
  if (mode === "exclusive") {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${REBUILD_LOCK})::bigint)`;
    return;
  }

  await tx`SELECT pg_advisory_xact_lock_shared(hashtext(${REBUILD_LOCK})::bigint)`;
}

export interface ReputationRecountRun {
  readonly id: string;
  readonly status: "running" | "done";
  readonly reason: string;
  readonly totalMembers: number;
  readonly processedMembers: number;
  readonly changedMembers: number;
  readonly cursorMemberId: string;
  readonly rebuiltAt: Date | null;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt: Date | null;
}

interface RecountRow {
  readonly id: string;
  readonly status: "running" | "done";
  readonly reason: string;
  readonly total_members: number;
  readonly processed_members: number;
  readonly changed_members: number;
  readonly cursor_member_id: string;
  readonly rebuilt_at: Date | null;
  readonly started_at: Date;
  readonly updated_at: Date;
  readonly finished_at: Date | null;
}

function recountRun(row: RecountRow): ReputationRecountRun {
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    totalMembers: row.total_members,
    processedMembers: row.processed_members,
    changedMembers: row.changed_members,
    cursorMemberId: row.cursor_member_id,
    rebuiltAt: row.rebuilt_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/** The active run, created on first use; both calls inside one board-recount job coalesce. */
export async function ensureRecountRun(tx: SQL, reason: string): Promise<ReputationRecountRun> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${RECOUNT_CLAIM_LOCK})::bigint)`;

  const [existing] = (await tx`
    SELECT
      id::text AS id, status, reason, total_members, processed_members, changed_members,
      cursor_member_id::text AS cursor_member_id, rebuilt_at, started_at, updated_at, finished_at
    FROM core.reputation_recounts
    WHERE status = 'running'
    ORDER BY core.reputation_recounts.id
    LIMIT 1
  `) as RecountRow[];

  if (existing !== undefined) {
    return recountRun(existing);
  }

  const [count] = (await tx`
    SELECT count(*)::int AS total FROM core.members
  `) as Array<{ total: number }>;

  const [created] = (await tx`
    INSERT INTO core.reputation_recounts (reason, total_members)
    VALUES (${reason}, ${count?.total ?? 0})
    RETURNING
      id::text AS id, status, reason, total_members, processed_members, changed_members,
      cursor_member_id::text AS cursor_member_id, rebuilt_at, started_at, updated_at, finished_at
  `) as RecountRow[];

  if (created === undefined) {
    throw new Error("Could not create the reputation recount run");
  }

  return recountRun(created);
}

export async function readRecountRun(
  sql: SQL,
  runId: string,
): Promise<ReputationRecountRun | null> {
  const [row] = (await sql`
    SELECT
      id::text AS id, status, reason, total_members, processed_members, changed_members,
      cursor_member_id::text AS cursor_member_id, rebuilt_at, started_at, updated_at, finished_at
    FROM core.reputation_recounts
    WHERE id = ${runId}
  `) as RecountRow[];

  return row === undefined ? null : recountRun(row);
}

export async function markRecountRebuilt(sql: SQL, runId: string): Promise<void> {
  await sql`
    UPDATE core.reputation_recounts
    SET rebuilt_at = now(), updated_at = now()
    WHERE id = ${runId}
  `;
}

export async function updateRecountProgress(
  sql: SQL,
  runId: string,
  progress: {
    readonly cursorMemberId: string;
    readonly processed: number;
    readonly changed: number;
  },
): Promise<void> {
  await sql`
    UPDATE core.reputation_recounts
    SET cursor_member_id = ${progress.cursorMemberId},
        processed_members = processed_members + ${progress.processed},
        changed_members = changed_members + ${progress.changed},
        updated_at = now()
    WHERE id = ${runId}
  `;
}

export async function finishRecountRun(sql: SQL, runId: string): Promise<void> {
  await sql`
    UPDATE core.reputation_recounts
    SET status = 'done', finished_at = now(), updated_at = now()
    WHERE id = ${runId}
  `;
}

/** Recent recounts for the staff progress panel, newest first. */
export async function listRecountRuns(
  sql: SQL,
  limit = 10,
): Promise<readonly ReputationRecountRun[]> {
  const rows = (await sql`
    SELECT
      id::text AS id, status, reason, total_members, processed_members, changed_members,
      cursor_member_id::text AS cursor_member_id, rebuilt_at, started_at, updated_at, finished_at
    FROM core.reputation_recounts
    ORDER BY core.reputation_recounts.id DESC
    LIMIT ${limit}
  `) as RecountRow[];

  return rows.map(recountRun);
}
