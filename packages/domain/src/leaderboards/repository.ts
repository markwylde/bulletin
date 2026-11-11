import type { SQL } from "bun";
import { leaderboardMutation } from "../mutations/board.ts";
import { runMutation } from "../mutations/index.ts";
import { can } from "../permissions/can.ts";
import { GUEST_PRINCIPAL } from "../permissions/principal.ts";
import type { PermissionSnapshot } from "../permissions/snapshot.ts";
import type { ForumTree } from "../permissions/tree.ts";

export const LEADERBOARD_PERIODS = ["today", "week", "month", "all"] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

export const LEADERBOARD_METRICS = ["posts", "reactions"] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

export function isLeaderboardPeriod(value: string): value is LeaderboardPeriod {
  return (LEADERBOARD_PERIODS as readonly string[]).includes(value);
}

export function isLeaderboardMetric(value: string): value is LeaderboardMetric {
  return (LEADERBOARD_METRICS as readonly string[]).includes(value);
}

export interface LeaderboardEntry {
  readonly memberId: string;
  readonly displayName: string;
  readonly avatarHash: string | null;
  readonly value: number;
}

interface LeaderboardRow {
  readonly member_id: string;
  readonly display_name: string;
  readonly avatar_hash: string | null;
  readonly value: number;
}

/** Forums Guests may read now; leaderboard reads only sum these (tasks 4.4, 4.5). */
export async function guestReadableForumIds(
  sql: SQL,
  tree: ForumTree,
  snapshot: PermissionSnapshot,
): Promise<readonly string[]> {
  const readable: string[] = [];

  for (const forumId of tree.ids) {
    if (
      await can(sql, GUEST_PRINCIPAL, "read", {
        forumId,
        tree,
        sessionId: null,
        snapshot,
      })
    ) {
      readable.push(forumId);
    }
  }

  return readable;
}

/**
 * Sums materialised per-forum rows over only the forums Guests may read now. A forum made
 * private stops contributing on the next request, without waiting for a recompute.
 */
function startFor(period: LeaderboardPeriod, now: Date): Date | null {
  if (period === "all") {
    return null;
  }

  const start = new Date(now);

  if (period === "today") {
    start.setHours(0, 0, 0, 0);
    return start;
  }

  if (period === "week") {
    const day = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - day);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * Counts authoritative visible content in forums Guests may read now, rather than trusting a
 * materialised forum id: a post moved into a private forum or deleted stops contributing on
 * the next request.
 */
export async function readLeaderboard(
  sql: SQL,
  input: {
    readonly period: LeaderboardPeriod;
    readonly metric: LeaderboardMetric;
    readonly tree: ForumTree;
    readonly snapshot: PermissionSnapshot;
    readonly limit?: number;
    readonly now?: Date;
  },
): Promise<readonly LeaderboardEntry[]> {
  const forums = await guestReadableForumIds(sql, input.tree, input.snapshot);

  if (forums.length === 0) {
    return [];
  }

  const start = startFor(input.period, input.now ?? new Date());
  const forumArray = `{${forums.join(",")}}`;
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const rows =
    input.metric === "posts"
      ? ((await sql`
          SELECT
            p.author_id::text AS member_id,
            m.display_name,
            m.avatar_hash,
            count(*)::int AS value
          FROM core.posts p
          JOIN core.topics t ON t.id = p.topic_id
          JOIN core.members m ON m.id = p.author_id
          WHERE p.visibility = 'visible'
            AND p.author_id IS NOT NULL
            AND t.forum_id = ANY(${forumArray}::bigint[])
            AND (${start}::timestamptz IS NULL OR p.created_at >= ${start})
            AND m.display_name IS NOT NULL
            AND m.state = 'active'
          GROUP BY p.author_id, m.display_name, m.avatar_hash
          ORDER BY value DESC, lower(m.display_name), p.author_id
          LIMIT ${limit}
        `) as LeaderboardRow[])
      : ((await sql`
          SELECT
            p.author_id::text AS member_id,
            m.display_name,
            m.avatar_hash,
            count(*)::int AS value
          FROM core.post_reactions pr
          JOIN core.posts p ON p.id = pr.post_id
          JOIN core.topics t ON t.id = p.topic_id
          JOIN core.members m ON m.id = p.author_id
          WHERE p.visibility = 'visible'
            AND p.author_id IS NOT NULL
            AND t.forum_id = ANY(${forumArray}::bigint[])
            AND (${start}::timestamptz IS NULL OR pr.created_at >= ${start})
            AND m.display_name IS NOT NULL
            AND m.state = 'active'
          GROUP BY p.author_id, m.display_name, m.avatar_hash
          ORDER BY value DESC, lower(m.display_name), p.author_id
          LIMIT ${limit}
        `) as LeaderboardRow[]);

  return rows.map((row) => ({
    memberId: row.member_id,
    displayName: row.display_name,
    avatarHash: row.avatar_hash,
    value: row.value,
  }));
}

export async function readTodayTopPoster(
  sql: SQL,
  input: { readonly tree: ForumTree; readonly snapshot: PermissionSnapshot },
): Promise<LeaderboardEntry | null> {
  const [top] = await readLeaderboard(sql, {
    ...input,
    period: "today",
    metric: "posts",
    limit: 1,
  });

  return top ?? null;
}

export interface LeaderboardRecomputeResult {
  readonly rows: number;
}

function periodStart(period: LeaderboardPeriod, now: Date): Date | null {
  if (period === "all") {
    return null;
  }

  const start = new Date(now);

  if (period === "today") {
    start.setHours(0, 0, 0, 0);
    return start;
  }

  if (period === "week") {
    // Monday 00:00 local time.
    const day = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - day);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** Rebuilds every materialised period/metric from authoritative posts and reactions. */
/** Rebuilds every materialised period/metric in the caller's transaction. */
export async function rebuildLeaderboards(
  tx: SQL,
  now: Date = new Date(),
): Promise<LeaderboardRecomputeResult> {
  let rows = 0;

  for (const period of LEADERBOARD_PERIODS) {
    const start = periodStart(period, now);

    for (const metric of LEADERBOARD_METRICS) {
      await tx`
        DELETE FROM core.leaderboard_entries
        WHERE period = ${period} AND metric = ${metric}
      `;

      const inserted =
        metric === "posts"
          ? ((await tx`
              INSERT INTO core.leaderboard_entries (
                period, metric, member_id, forum_id, value, updated_at
              )
              SELECT
                ${period}, 'posts', p.author_id, t.forum_id, count(*)::int, ${now}
              FROM core.posts p
              JOIN core.topics t ON t.id = p.topic_id
              WHERE p.visibility = 'visible'
                AND p.author_id IS NOT NULL
                AND (${start}::timestamptz IS NULL OR p.created_at >= ${start})
              GROUP BY p.author_id, t.forum_id
              RETURNING 1
            `) as unknown[])
          : ((await tx`
              INSERT INTO core.leaderboard_entries (
                period, metric, member_id, forum_id, value, updated_at
              )
              SELECT
                ${period}, 'reactions', p.author_id, t.forum_id, count(*)::int, ${now}
              FROM core.post_reactions pr
              JOIN core.posts p ON p.id = pr.post_id
              JOIN core.topics t ON t.id = p.topic_id
              WHERE p.visibility = 'visible'
                AND p.author_id IS NOT NULL
                AND (${start}::timestamptz IS NULL OR pr.created_at >= ${start})
              GROUP BY p.author_id, t.forum_id
              RETURNING 1
            `) as unknown[]);

      rows += inserted.length;
    }
  }

  return { rows };
}

/** Rebuilds leaderboards with the cache-tag bump (the hourly worker entry point). */
export async function recomputeLeaderboards(
  sql: SQL,
  now: Date = new Date(),
): Promise<LeaderboardRecomputeResult> {
  return runMutation({
    sql,
    mutation: leaderboardMutation,
    input: {},
    apply: (tx) => rebuildLeaderboards(tx, now),
  });
}
