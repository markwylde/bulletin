import type { SQL } from "bun";
import { emit } from "../../events/outbox.ts";
import { runMutation } from "../../mutations/index.ts";
import {
  type BulkHeldContentSummary,
  postApproveMutation,
  postRejectMutation,
} from "../../mutations/topics.ts";
import { can } from "../../permissions/can.ts";
import { loadPermissionSnapshot } from "../../permissions/snapshot.ts";
import type { ForumTree } from "../../permissions/tree.ts";
import { loadForumTree } from "../../permissions/tree-store.ts";
import {
  adjustForumPostCount,
  adjustForumTopicCount,
  adjustMemberPostCount,
  adjustMemberPostCounts,
  adjustTopicReplyCount,
  deletePostRow,
  deleteTopicRow,
  loadTopicForWrite,
  lockTopicForWrite,
  recountTopic,
  refreshForumLastPost,
  setPostVisibility,
  visiblePostCountsByAuthor,
} from "../../topics/repository.ts";
import { writeModerationLog } from "../log/repository.ts";

export type { HoldReason } from "../needs-approval.ts";
export * from "../needs-approval.ts";

export interface ModeratedForum {
  readonly id: string;
  readonly title: string;
}

export interface ModerationQueueItem {
  /** The held post; a held topic is represented by its first post. */
  readonly postId: string;
  readonly kind: "topic" | "post";
  readonly topicId: string;
  readonly topicTitle: string;
  readonly topicSlug: string;
  readonly forumId: string;
  readonly forumTitle: string;
  readonly authorId: string | null;
  readonly authorName: string | null;
  /** Plain-text preview; the moderator view truncates it. */
  readonly preview: string;
  readonly createdAt: Date;
  readonly reason: string | null;
  readonly position: number;
}

export interface ModerationQueuePage {
  readonly items: readonly ModerationQueueItem[];
  readonly total: number;
  readonly forums: readonly ModeratedForum[];
}

export type ModerationOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly code: "forbidden" | "invalid_request" };

export interface ApprovalSummary extends BulkHeldContentSummary {
  readonly postIds: readonly string[];
  readonly authorIds: readonly string[];
}

interface ModeratedForumRow {
  readonly id: string;
  readonly title: string;
}

/** Forums the actor may approve in, including every ancestor's moderator assignment. */
export async function moderatedForums(
  sql: SQL,
  actorId: string,
  sessionId: string | null = null,
  tree?: ForumTree,
): Promise<readonly ModeratedForum[]> {
  const loadedTree = tree ?? (await loadForumTree(sql));
  const snapshot = await loadPermissionSnapshot(sql, actorId, {
    tree: loadedTree,
    sessionId,
  });
  const ids: string[] = [];

  for (const forumId of loadedTree.ids) {
    if (forumId === "0") {
      continue;
    }

    if (await can(sql, actorId, "approve", { forumId, tree: loadedTree, snapshot, sessionId })) {
      ids.push(forumId);
    }
  }

  if (ids.length === 0) {
    return [];
  }

  const rows = (await sql`
    SELECT id::text AS id, title
    FROM core.forums
    WHERE id = ANY(${`{${ids.join(",")}}`}::bigint[])
    ORDER BY path, position, id
  `) as ModeratedForumRow[];

  return rows.map((row) => ({ id: row.id, title: row.title }));
}

interface QueueRow {
  readonly post_id: string;
  readonly topic_id: string;
  readonly topic_title: string;
  readonly topic_slug: string;
  readonly forum_id: string;
  readonly forum_title: string;
  readonly author_id: string | null;
  readonly author_name: string | null;
  readonly body_text: string;
  readonly created_at: Date;
  readonly hold_reason: string | null;
  readonly topic_hold_reason: string | null;
  readonly position: number;
  readonly topic_visibility: string;
}

function preview(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 280 ? `${text.slice(0, 277)}…` : text;
}

/**
 * The queue is scoped by the moderator's own `approve` bit, never by a forum id supplied by
 * the client. Held topics appear once, as their first post; held replies appear individually.
 */
export async function listApprovalQueue(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly limit: number;
    readonly offset: number;
    readonly sessionId?: string | null;
    readonly forumId?: string | null;
  },
): Promise<ModerationQueuePage> {
  const forums = await moderatedForums(sql, input.actorId, input.sessionId ?? null);

  if (forums.length === 0) {
    return { items: [], total: 0, forums: [] };
  }

  const allowed = forums.map((forum) => forum.id).join(",");
  const forumFilter =
    input.forumId === undefined || input.forumId === null
      ? sql`TRUE`
      : sql`t.forum_id = ${input.forumId}::bigint`;
  const rows = (await sql`
    SELECT
      p.id::text AS post_id, t.id::text AS topic_id, t.title AS topic_title,
      t.slug AS topic_slug, t.forum_id::text AS forum_id, f.title AS forum_title,
      p.author_id::text AS author_id, author.display_name AS author_name,
      p.body_text, p.created_at, p.hold_reason, t.hold_reason AS topic_hold_reason,
      p.position, t.visibility AS topic_visibility
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    JOIN core.forums f ON f.id = t.forum_id
    LEFT JOIN core.members author ON author.id = p.author_id
    WHERE p.visibility = 'unapproved'
      AND t.forum_id = ANY(${`{${allowed}}`}::bigint[])
      AND ${forumFilter}
    ORDER BY p.created_at, p.id
    LIMIT ${input.limit} OFFSET ${input.offset}
  `) as QueueRow[];
  const [count] = (await sql`
    SELECT count(*)::int AS count
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.visibility = 'unapproved'
      AND t.forum_id = ANY(${`{${allowed}}`}::bigint[])
      AND ${forumFilter}
  `) as Array<{ count: number }>;

  return {
    items: rows.map((row) => ({
      postId: row.post_id,
      kind: row.position === 1 && row.topic_visibility === "unapproved" ? "topic" : "post",
      topicId: row.topic_id,
      topicTitle: row.topic_title,
      topicSlug: row.topic_slug,
      forumId: row.forum_id,
      forumTitle: row.forum_title,
      authorId: row.author_id,
      authorName: row.author_name,
      preview: preview(row.body_text),
      createdAt: row.created_at,
      reason: row.hold_reason ?? row.topic_hold_reason,
      position: row.position,
    })),
    total: count?.count ?? 0,
    forums,
  };
}

/** The live count for one moderator, used by the dashboard widget and the queue badge. */
export async function pendingApprovalCount(
  sql: SQL,
  actorId: string,
  sessionId: string | null = null,
): Promise<number> {
  const forums = await moderatedForums(sql, actorId, sessionId);

  if (forums.length === 0) {
    return 0;
  }

  const allowed = forums.map((forum) => forum.id).join(",");
  const [row] = (await sql`
    SELECT count(*)::int AS count
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.visibility = 'unapproved'
      AND t.forum_id = ANY(${`{${allowed}}`}::bigint[])
  `) as Array<{ count: number }>;

  return row?.count ?? 0;
}

function forumChain(tree: ForumTree, forumId: string): readonly string[] {
  return [...tree.ancestors(forumId).map((node) => node.id), forumId];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

interface HeldPostTarget {
  readonly postId: string;
  readonly topicId: string;
  readonly forumId: string;
  readonly authorId: string | null;
  readonly position: number;
}

interface HeldPostRow {
  readonly post_id: string;
  readonly topic_id: string;
  readonly forum_id: string;
  readonly author_id: string | null;
  readonly position: number;
}

async function readHeldTargets(
  sql: SQL,
  postIds: readonly string[],
): Promise<readonly HeldPostTarget[]> {
  if (postIds.length === 0) {
    return [];
  }

  const rows = (await sql`
    SELECT p.id::text AS post_id, p.topic_id::text AS topic_id, t.forum_id::text AS forum_id,
      p.author_id::text AS author_id, p.position
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ANY(${`{${postIds.join(",")}}`}::bigint[])
    ORDER BY t.id, p.id
  `) as HeldPostRow[];

  return rows.map((row) => ({
    postId: row.post_id,
    topicId: row.topic_id,
    forumId: row.forum_id,
    authorId: row.author_id,
    position: row.position,
  }));
}

function sortTargets(targets: readonly HeldPostTarget[]): readonly HeldPostTarget[] {
  const big = (value: string): bigint => BigInt(value);
  return [...targets].sort((left, right) => {
    const topic = big(left.topicId) - big(right.topicId);
    return topic === 0n ? Number(big(left.postId) - big(right.postId)) : Number(topic);
  });
}

interface LockedHeldTarget extends HeldPostTarget {
  readonly visibility: string;
}

/**
 * Locks every affected topic in id order, then every post, and re-reads the current
 * topic/forum coordinates. A concurrent move or split therefore cannot let an approval or
 * rejection act on the forum the target used to belong to.
 */
async function lockHeldTargets(
  tx: SQL,
  targets: readonly HeldPostTarget[],
): Promise<readonly LockedHeldTarget[]> {
  const ordered = sortTargets(targets);
  const lockedTopics = new Set<string>();

  for (const target of ordered) {
    if (!lockedTopics.has(target.topicId)) {
      await lockTopicForWrite(tx, target.topicId);
      lockedTopics.add(target.topicId);
    }
  }

  const postIds = ordered.map((target) => target.postId);
  await tx`SELECT id FROM core.posts WHERE id = ANY(${`{${postIds.join(",")}}`}::bigint[])
    ORDER BY id FOR UPDATE`;

  const first = (await tx`
    SELECT p.id::text AS post_id, p.topic_id::text AS topic_id, t.forum_id::text AS forum_id,
      p.author_id::text AS author_id, p.position, p.visibility
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ANY(${`{${postIds.join(",")}}`}::bigint[])
    ORDER BY p.id
  `) as Array<{
    post_id: string;
    topic_id: string;
    forum_id: string;
    author_id: string | null;
    position: number;
    visibility: string;
  }>;

  for (const row of first) {
    if (!lockedTopics.has(row.topic_id)) {
      await lockTopicForWrite(tx, row.topic_id);
      lockedTopics.add(row.topic_id);
    }
  }

  // The topic lock makes forum_id stable; read it once more after every topic is locked.
  const rows = (await tx`
    SELECT p.id::text AS post_id, p.topic_id::text AS topic_id, t.forum_id::text AS forum_id,
      p.author_id::text AS author_id, p.position, p.visibility
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
    WHERE p.id = ANY(${`{${postIds.join(",")}}`}::bigint[])
    ORDER BY p.id
  `) as Array<{
    post_id: string;
    topic_id: string;
    forum_id: string;
    author_id: string | null;
    position: number;
    visibility: string;
  }>;

  return rows.map((row) => ({
    postId: row.post_id,
    topicId: row.topic_id,
    forumId: row.forum_id,
    authorId: row.author_id,
    position: row.position,
    visibility: row.visibility,
  }));
}

async function canApproveTargets(
  sql: SQL,
  actorId: string,
  sessionId: string | null,
  tree: ForumTree,
  targets: readonly HeldPostTarget[],
): Promise<boolean> {
  for (const target of targets) {
    if (!(await can(sql, actorId, "approve", { forumId: target.forumId, tree, sessionId }))) {
      return false;
    }
  }

  return true;
}

async function rejectForbidden(): Promise<never> {
  throw new ApprovalRejected("forbidden");
}

class ApprovalRejected extends Error {
  readonly code: "forbidden";

  constructor(code: "forbidden") {
    super(`Approval rejected: ${code}`);
    this.name = "ApprovalRejected";
    this.code = code;
  }
}

function rejected(error: unknown): { readonly ok: false; readonly code: "forbidden" } | null {
  return error instanceof ApprovalRejected ? { ok: false, code: error.code } : null;
}

/**
 * Approves held posts in bulk. Topic and post rows are locked in id order, then each item is
 * re-read, so a concurrent delete or approval cannot double count. Held content was never in
 * the public counters, so approval adds the counters now; a held topic also becomes visible.
 */
export async function approveHeldPosts(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly postIds: readonly string[];
    readonly sessionId?: string | null;
  },
): Promise<ModerationOutcome<ApprovalSummary>> {
  const postIds = unique(input.postIds.filter((id) => /^\d+$/.test(id)));

  if (postIds.length === 0) {
    return { ok: false, code: "invalid_request" };
  }

  const targets = sortTargets(await readHeldTargets(sql, postIds));
  const tree = await loadForumTree(sql);

  if (!(await canApproveTargets(sql, input.actorId, input.sessionId ?? null, tree, targets))) {
    return { ok: false, code: "forbidden" };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: postApproveMutation,
      input: { postIds },
      apply: async (tx) => {
        const freshTree = await loadForumTree(tx);
        const lockedTargets = await lockHeldTargets(tx, targets);
        const approved: string[] = [];
        const topicIds: string[] = [];
        const forumIds: string[] = [];
        const memberIds: string[] = [];

        for (const target of lockedTargets) {
          if (
            !(await can(tx, input.actorId, "approve", {
              forumId: target.forumId,
              tree: freshTree,
              sessionId: input.sessionId ?? null,
            }))
          ) {
            await rejectForbidden();
          }

          const topic = await loadTopicForWrite(tx, target.topicId);

          if (topic === null) {
            continue;
          }

          const rows = (await tx`
            SELECT visibility FROM core.posts WHERE id = ${target.postId} FOR UPDATE
          `) as Array<{ visibility: string }>;

          if (rows[0]?.visibility !== "unapproved") {
            continue;
          }

          const topicBecomesVisible = target.position === 1 && topic.visibility === "unapproved";

          await setPostVisibility(tx, target.postId, "visible");
          await tx`UPDATE core.posts SET hold_reason = NULL WHERE id = ${target.postId}`;

          if (topicBecomesVisible) {
            // A hidden topic may have replies that were removed from the counters when the
            // opener was held (or were never counted); restoring the whole topic is exact.
            const counts = await visiblePostCountsByAuthor(tx, target.topicId);
            const total = [...counts.values()].reduce((sum, count) => sum + count, 0);

            await tx`
              UPDATE core.topics SET visibility = 'visible', hold_reason = NULL, updated_at = now()
              WHERE id = ${target.topicId}
            `;
            await adjustForumTopicCount(tx, target.forumId, 1);
            await adjustForumPostCount(tx, target.forumId, total);
            await adjustMemberPostCounts(tx, counts, 1);
            memberIds.push(...counts.keys());
          } else if (target.position > 1) {
            await adjustForumPostCount(tx, target.forumId, 1);
            await adjustTopicReplyCount(tx, target.topicId, 1);

            if (target.authorId !== null) {
              await adjustMemberPostCount(tx, target.authorId, 1);
              memberIds.push(target.authorId);
            }
          } else {
            await adjustForumPostCount(tx, target.forumId, 1);

            if (target.authorId !== null) {
              await adjustMemberPostCount(tx, target.authorId, 1);
              memberIds.push(target.authorId);
            }
          }

          await recountTopic(tx, target.topicId);
          await refreshForumLastPost(tx, target.forumId);

          await emit(tx, {
            type: "post.approved",
            aggregateId: BigInt(target.postId),
            aggregateVersion: 1n,
            payloadIds: {
              postId: BigInt(target.postId),
              topicId: BigInt(target.topicId),
              forumId: BigInt(target.forumId),
              authorId: BigInt(target.authorId ?? "0"),
              actorId: BigInt(input.actorId),
            },
          });

          await writeModerationLog(tx, {
            actorId: input.actorId,
            action: "post.approve",
            targetType: "post",
            targetId: target.postId,
            forumId: target.forumId,
            memberId: target.authorId,
            details: { topicId: target.topicId, position: target.position },
          });

          approved.push(target.postId);
          topicIds.push(target.topicId);
          forumIds.push(...forumChain(freshTree, target.forumId));
        }

        return {
          postIds: approved,
          authorIds: unique(memberIds),
          topicIds: unique(topicIds),
          forumIds: unique(forumIds),
          memberIds: unique(memberIds),
        } satisfies ApprovalSummary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    const failure = rejected(error);

    if (failure !== null) {
      return failure;
    }

    throw error;
  }
}

/**
 * Rejects held content by permanently deleting it. Rejection never touches counters because
 * held rows were never counted; a held topic's first post deletes the whole topic.
 */
export async function rejectHeldPosts(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly postIds: readonly string[];
    readonly sessionId?: string | null;
  },
): Promise<ModerationOutcome<ApprovalSummary>> {
  const postIds = unique(input.postIds.filter((id) => /^\d+$/.test(id)));

  if (postIds.length === 0) {
    return { ok: false, code: "invalid_request" };
  }

  const targets = sortTargets(await readHeldTargets(sql, postIds));
  const tree = await loadForumTree(sql);

  if (!(await canApproveTargets(sql, input.actorId, input.sessionId ?? null, tree, targets))) {
    return { ok: false, code: "forbidden" };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: postRejectMutation,
      input: { postIds },
      apply: async (tx) => {
        const freshTree = await loadForumTree(tx);
        const lockedTargets = await lockHeldTargets(tx, targets);
        const removed: string[] = [];
        const topicIds: string[] = [];
        const forumIds: string[] = [];
        const memberIds: string[] = [];

        for (const target of lockedTargets) {
          if (
            !(await can(tx, input.actorId, "approve", {
              forumId: target.forumId,
              tree: freshTree,
              sessionId: input.sessionId ?? null,
            }))
          ) {
            await rejectForbidden();
          }

          const topic = await loadTopicForWrite(tx, target.topicId);

          if (topic === null) {
            continue;
          }

          const rows = (await tx`
            SELECT visibility, position FROM core.posts WHERE id = ${target.postId} FOR UPDATE
          `) as Array<{ visibility: string; position: number }>;
          const post = rows[0];

          if (post === undefined) {
            continue;
          }

          // A concurrent approval can publish the row between the target read and this lock;
          // rejection must never hard-delete published content.
          if (post.visibility !== "unapproved") {
            continue;
          }

          if (post.position === 1) {
            await deleteTopicRow(tx, target.topicId);
          } else {
            await deletePostRow(tx, target.postId);
          }

          topicIds.push(target.topicId);

          await emit(tx, {
            type: "post.deleted",
            aggregateId: BigInt(target.postId),
            aggregateVersion: 1n,
            payloadIds: {
              postId: BigInt(target.postId),
              topicId: BigInt(target.topicId),
              forumId: BigInt(target.forumId),
              authorId: BigInt(target.authorId ?? "0"),
              actorId: BigInt(input.actorId),
            },
          });

          await writeModerationLog(tx, {
            actorId: input.actorId,
            action: "post.reject",
            targetType: "post",
            targetId: target.postId,
            forumId: target.forumId,
            memberId: target.authorId,
            details: { topicId: target.topicId, position: target.position },
          });

          removed.push(target.postId);
          forumIds.push(...forumChain(freshTree, target.forumId));

          if (target.authorId !== null) {
            memberIds.push(target.authorId);
          }
        }

        return {
          postIds: removed,
          authorIds: unique(memberIds),
          topicIds: unique(topicIds),
          forumIds: unique(forumIds),
          memberIds: unique(memberIds),
        } satisfies ApprovalSummary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    const failure = rejected(error);

    if (failure !== null) {
      return failure;
    }

    throw error;
  }
}
