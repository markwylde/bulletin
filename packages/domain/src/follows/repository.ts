import type { SQL } from "bun";
import { can } from "../permissions/can.ts";
import { loadPermissionSnapshot, type PermissionSnapshot } from "../permissions/snapshot.ts";
import type { ForumTree } from "../permissions/tree.ts";
import { loadForumTree } from "../permissions/tree-store.ts";

/** The three things a member can follow (follows spec, ADR 0011). */
export const FOLLOW_KINDS = ["topic", "forum", "member"] as const;

export type FollowKind = (typeof FOLLOW_KINDS)[number];

export function isFollowKind(value: string): value is FollowKind {
  return (FOLLOW_KINDS as readonly string[]).includes(value);
}

const FOLLOW_TARGET = /^(topic|forum|member):([1-9]\d{0,18})$/;

/** The overlay target key, e.g. `topic:12`; never contains any state itself. */
export function followTarget(kind: FollowKind, id: string): string {
  return `${kind}:${id}`;
}

/** Accepts only well-formed ids the page rendered, so the overlay cannot scan follows. */
export function parseFollowTargets(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const targets: string[] = [];

  for (const entry of value.slice(0, 100)) {
    if (typeof entry === "string" && FOLLOW_TARGET.test(entry)) {
      targets.push(entry);
    }
  }

  return [...new Set(targets)];
}

export type FollowOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "not_found" | "self" };

export interface FollowInput {
  readonly memberId: string;
  readonly kind: FollowKind;
  readonly id: string;
  /** Grants forum-password unlocks when checking readability. */
  readonly sessionId?: string | null;
}

async function readableForum(
  sql: SQL,
  memberId: string,
  forumId: string,
  tree: ForumTree,
  snapshot: PermissionSnapshot,
): Promise<boolean> {
  return can(sql, memberId, "read", { forumId, tree, snapshot });
}

/**
 * Follows one target after checking the member can read it now. A hidden or missing target is
 * reported as `not_found`, which never reveals whether it exists (ADR 0005, follows spec).
 */
export async function follow(sql: SQL, input: FollowInput): Promise<FollowOutcome> {
  switch (input.kind) {
    case "topic": {
      const [topic] = (await sql`
        SELECT forum_id
        FROM core.topics
        WHERE id = ${input.id}
      `) as Array<{ forum_id: string }>;

      if (topic === undefined) {
        return { ok: false, code: "not_found" };
      }

      const tree = await loadForumTree(sql);
      const snapshot = await loadPermissionSnapshot(sql, input.memberId, {
        tree,
        sessionId: input.sessionId ?? null,
      });

      if (!(await readableForum(sql, input.memberId, topic.forum_id, tree, snapshot))) {
        return { ok: false, code: "not_found" };
      }

      await sql`
        INSERT INTO core.followed_topics (member_id, topic_id)
        VALUES (${input.memberId}, ${input.id})
        ON CONFLICT DO NOTHING
      `;
      return { ok: true };
    }
    case "forum": {
      const [forum] = (await sql`
        SELECT id
        FROM core.forums
        WHERE id = ${input.id}
      `) as Array<{ id: string }>;

      if (forum === undefined) {
        return { ok: false, code: "not_found" };
      }

      const tree = await loadForumTree(sql);
      const snapshot = await loadPermissionSnapshot(sql, input.memberId, {
        tree,
        sessionId: input.sessionId ?? null,
      });

      if (!(await readableForum(sql, input.memberId, forum.id, tree, snapshot))) {
        return { ok: false, code: "not_found" };
      }

      await sql`
        INSERT INTO core.followed_forums (member_id, forum_id)
        VALUES (${input.memberId}, ${input.id})
        ON CONFLICT DO NOTHING
      `;
      return { ok: true };
    }
    case "member": {
      if (input.id === input.memberId) {
        return { ok: false, code: "self" };
      }

      const [member] = (await sql`
        SELECT id
        FROM core.members
        WHERE id = ${input.id} AND is_service = false
      `) as Array<{ id: string }>;

      if (member === undefined) {
        return { ok: false, code: "not_found" };
      }

      await sql`
        INSERT INTO core.followed_members (follower_id, followed_id)
        VALUES (${input.memberId}, ${input.id})
        ON CONFLICT DO NOTHING
      `;
      return { ok: true };
    }
  }
}

/** Unfollowing never needs a permission check, so follows of lost content can be removed. */
export async function unfollow(
  sql: SQL,
  input: { readonly memberId: string; readonly kind: FollowKind; readonly id: string },
): Promise<void> {
  switch (input.kind) {
    case "topic":
      await sql`
        DELETE FROM core.followed_topics WHERE member_id = ${input.memberId} AND topic_id = ${input.id}
      `;
      return;
    case "forum":
      await sql`
        DELETE FROM core.followed_forums WHERE member_id = ${input.memberId} AND forum_id = ${input.id}
      `;
      return;
    case "member":
      await sql`
        DELETE FROM core.followed_members
        WHERE follower_id = ${input.memberId} AND followed_id = ${input.id}
      `;
  }
}

/** The subset of the page's rendered follow targets that the member follows (overlay state). */
export async function followedTargets(
  sql: SQL,
  memberId: string,
  targets: readonly string[],
): Promise<readonly string[]> {
  const buckets = { topic: [] as string[], forum: [] as string[], member: [] as string[] };

  for (const target of targets) {
    const match = FOLLOW_TARGET.exec(target);

    if (match !== null && isFollowKind(match[1] ?? "")) {
      buckets[match[1] as FollowKind].push(match[2] ?? "");
    }
  }

  const rows = (await sql`
    SELECT 'topic:' || topic_id AS target
    FROM core.followed_topics
    WHERE member_id = ${memberId}
      AND topic_id = ANY(${`{${buckets.topic.join(",")}}`}::bigint[])
    UNION ALL
    SELECT 'forum:' || forum_id AS target
    FROM core.followed_forums
    WHERE member_id = ${memberId}
      AND forum_id = ANY(${`{${buckets.forum.join(",")}}`}::bigint[])
    UNION ALL
    SELECT 'member:' || followed_id AS target
    FROM core.followed_members
    WHERE follower_id = ${memberId}
      AND followed_id = ANY(${`{${buckets.member.join(",")}}`}::bigint[])
  `) as Array<{ target: string }>;
  const found = new Set(rows.map((row) => row.target));

  return targets.filter((target) => found.has(target));
}

export interface FollowedTopic {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly forumId: string;
  readonly followedAt: Date;
  readonly available: boolean;
}

export interface FollowedForum {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly followedAt: Date;
  readonly available: boolean;
}

export interface FollowedMember {
  readonly id: string;
  readonly displayName: string;
  readonly followedAt: Date;
}

export interface FollowsList {
  readonly topics: readonly FollowedTopic[];
  readonly forums: readonly FollowedForum[];
  readonly members: readonly FollowedMember[];
}

/**
 * Every follow of the member, newest first, with readability evaluated against current state.
 * Inaccessible topics and forums stay listed but unavailable (follows spec).
 */
export async function listFollows(
  sql: SQL,
  memberId: string,
  sessionId: string | null = null,
): Promise<FollowsList> {
  const tree = await loadForumTree(sql);
  const snapshot = await loadPermissionSnapshot(sql, memberId, { tree, sessionId });
  const [topicRows, forumRows, memberRows] = (await Promise.all([
    sql`
      SELECT f.topic_id::text AS id, t.title, t.slug, t.forum_id::text AS forum_id,
        f.created_at AS followed_at
      FROM core.followed_topics f
      JOIN core.topics t ON t.id = f.topic_id
      WHERE f.member_id = ${memberId}
      ORDER BY f.created_at DESC
    `,
    sql`
      SELECT f.forum_id::text AS id, fo.title, fo.slug, f.created_at AS followed_at
      FROM core.followed_forums f
      JOIN core.forums fo ON fo.id = f.forum_id
      WHERE f.member_id = ${memberId}
      ORDER BY f.created_at DESC
    `,
    sql`
      SELECT f.followed_id::text AS id, m.display_name, f.created_at AS followed_at
      FROM core.followed_members f
      JOIN core.members m ON m.id = f.followed_id
      WHERE f.follower_id = ${memberId}
      ORDER BY f.created_at DESC
    `,
  ])) as [
    Array<{
      id: string;
      title: string;
      slug: string;
      forum_id: string;
      followed_at: Date | string;
    }>,
    Array<{ id: string; title: string; slug: string; followed_at: Date | string }>,
    Array<{ id: string; display_name: string | null; followed_at: Date | string }>,
  ];

  return {
    topics: await Promise.all(
      topicRows.map(async (row) => {
        const available = await readableForum(sql, memberId, row.forum_id, tree, snapshot);

        return {
          id: row.id,
          // An inaccessible follow must not disclose the current (possibly renamed) title.
          title: available ? row.title : "",
          slug: available ? row.slug : "",
          forumId: row.forum_id,
          followedAt: new Date(row.followed_at),
          available,
        };
      }),
    ),
    forums: await Promise.all(
      forumRows.map(async (row) => {
        const available = await readableForum(sql, memberId, row.id, tree, snapshot);

        return {
          id: row.id,
          title: available ? row.title : "",
          slug: available ? row.slug : "",
          followedAt: new Date(row.followed_at),
          available,
        };
      }),
    ),
    members: memberRows.map((row) => ({
      id: row.id,
      displayName: row.display_name ?? `#${row.id}`,
      followedAt: new Date(row.followed_at),
    })),
  };
}

/** Auto-follow is on unless the member turned it off (follows spec). */
export async function autoFollowTopicsEnabled(sql: SQL, memberId: string): Promise<boolean> {
  const [row] = (await sql`
    SELECT auto_follow_topics
    FROM core.follow_settings
    WHERE member_id = ${memberId}
  `) as Array<{ auto_follow_topics: boolean }>;

  return row?.auto_follow_topics ?? true;
}

export async function setAutoFollowTopics(
  sql: SQL,
  memberId: string,
  enabled: boolean,
): Promise<void> {
  await sql`
    INSERT INTO core.follow_settings (member_id, auto_follow_topics)
    VALUES (${memberId}, ${enabled})
    ON CONFLICT (member_id) DO UPDATE
      SET auto_follow_topics = EXCLUDED.auto_follow_topics,
          updated_at = now()
  `;
}

/** Called inside the post's own transaction; idempotent and respects the member's choice. */
export async function autoFollowTopic(sql: SQL, memberId: string, topicId: string): Promise<void> {
  if (!(await autoFollowTopicsEnabled(sql, memberId))) {
    return;
  }

  await sql`
    INSERT INTO core.followed_topics (member_id, topic_id)
    VALUES (${memberId}, ${topicId})
    ON CONFLICT DO NOTHING
  `;
}
