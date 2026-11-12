import type { SQL } from "bun";
import { writeModerationLog } from "../../moderation/log/repository.ts";
import { approveHeldPosts } from "../../moderation/queue/repository.ts";
import { runMutation } from "../../mutations/index.ts";
import {
  type BulkHeldContentSummary,
  topicMergeMutation,
  topicSplitMutation,
} from "../../mutations/topics.ts";
import { can } from "../../permissions/can.ts";
import type { ForumTree } from "../../permissions/tree.ts";
import { loadForumTree } from "../../permissions/tree-store.ts";
import { slugify } from "../../urls/index.ts";
import {
  lock,
  move,
  pin,
  restore,
  restoreTopic,
  softDelete,
  softDeleteTopic,
} from "../moderation.ts";
import {
  adjustForumPostCount,
  adjustForumTopicCount,
  deleteTopicRow,
  insertTopic,
  loadForumTarget,
  loadPostForWrite,
  loadTopicForWrite,
  lockTopicForWrite,
  recountTopic,
  refreshForumLastPost,
} from "../repository.ts";
import type { TopicMutationOutcome } from "../result.ts";

const OFFSET = 10_000_000;

export interface MergeTopicsInput {
  readonly actorId: string;
  readonly destinationTopicId: string;
  readonly sourceTopicIds: readonly string[];
  readonly title?: string;
  readonly stubDays?: number;
  readonly sessionId?: string | null;
}

export interface SplitTopicInput {
  readonly actorId: string;
  readonly sourceTopicId: string;
  readonly postIds: readonly string[];
  readonly target:
    | { readonly kind: "new"; readonly forumId: string; readonly title: string }
    | { readonly kind: "existing"; readonly topicId: string };
  readonly sessionId?: string | null;
}

export interface TopicToolsSummary extends BulkHeldContentSummary {
  readonly topicId: string;
  readonly postIds: readonly string[];
}

function chain(tree: ForumTree, forumId: string): readonly string[] {
  return [...tree.ancestors(forumId).map((node) => node.id), forumId];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function validTitle(value: string, fallback: string): string | null {
  const title = value.trim() === "" ? fallback : value.trim();
  return title.length >= 3 && title.length <= 150 ? title : null;
}

async function lockTopics(tx: SQL, ids: readonly string[]): Promise<void> {
  const ordered = [...new Set(ids)]
    .filter((id) => /^\d+$/.test(id))
    .sort((left, right) => Number(BigInt(left) - BigInt(right)));

  for (const id of ordered) {
    await lockTopicForWrite(tx, id);
  }
}

async function canMergeAll(
  sql: SQL,
  actorId: string,
  sessionId: string | null,
  tree: ForumTree,
  forums: readonly string[],
): Promise<boolean> {
  for (const forumId of unique(forums)) {
    if (!(await can(sql, actorId, "merge", { forumId, tree, sessionId }))) {
      return false;
    }
  }

  return true;
}

async function canSplitAll(
  sql: SQL,
  actorId: string,
  sessionId: string | null,
  tree: ForumTree,
  forums: readonly string[],
): Promise<boolean> {
  for (const forumId of unique(forums)) {
    if (!(await can(sql, actorId, "split", { forumId, tree, sessionId }))) {
      return false;
    }
  }

  return true;
}

/**
 * Moving posts out of a topic that is held, hidden or deleted republishes content that was
 * removed from view, so the actor needs the `restore` power in every forum involved.
 */
async function canRestoreAll(
  sql: SQL,
  actorId: string,
  sessionId: string | null,
  tree: ForumTree,
  forums: readonly string[],
): Promise<boolean> {
  for (const forumId of unique(forums)) {
    if (!(await can(sql, actorId, "restore", { forumId, tree, sessionId }))) {
      return false;
    }
  }

  return true;
}

function republishesHiddenContent(
  topics: readonly ({ readonly visibility: string } | null)[],
): boolean {
  return topics.some((topic) => topic !== null && topic.visibility !== "visible");
}

/**
 * Merges one or more source topics into a destination. All affected topic rows are locked in
 * id order; posts are renumbered by creation time, then each source is removed or left as a
 * redirect stub.
 */
export async function mergeTopics(
  sql: SQL,
  input: MergeTopicsInput,
): Promise<TopicMutationOutcome<TopicToolsSummary>> {
  const sourceIds = unique(input.sourceTopicIds.filter((id) => id !== input.destinationTopicId));

  if (!/^\d+$/.test(input.destinationTopicId) || sourceIds.length === 0) {
    return { ok: false, code: "topic_not_found" };
  }

  const destination = await loadTopicForWrite(sql, input.destinationTopicId);

  if (destination === null || destination.movedTo !== null) {
    return { ok: false, code: "topic_not_found" };
  }

  const sources = await Promise.all(sourceIds.map((id) => loadTopicForWrite(sql, id)));

  if (sources.some((topic) => topic === null || topic.movedTo !== null)) {
    return { ok: false, code: "topic_not_found" };
  }

  const title = validTitle(input.title ?? "", destination.title);

  if (title === null) {
    return { ok: false, code: "invalid_title" };
  }

  const tree = await loadForumTree(sql);
  const forums = [
    destination.forumId,
    ...sources.flatMap((topic) => (topic === null ? [] : [topic.forumId])),
  ];

  if (!(await canMergeAll(sql, input.actorId, input.sessionId ?? null, tree, forums))) {
    return { ok: false, code: "forbidden" };
  }

  if (
    republishesHiddenContent(sources) &&
    !(await canRestoreAll(sql, input.actorId, input.sessionId ?? null, tree, forums))
  ) {
    return { ok: false, code: "forbidden" };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: topicMergeMutation,
      input: { destinationTopicId: destination.id, sourceTopicIds: sourceIds },
      apply: async (tx) => {
        await lockTopics(tx, [destination.id, ...sourceIds]);
        const freshTree = await loadForumTree(tx);
        const destinationCurrent = await loadTopicForWrite(tx, destination.id);

        if (destinationCurrent === null) {
          throw new Error("Destination topic disappeared during merge");
        }

        const sourcesCurrent = await Promise.all(sourceIds.map((id) => loadTopicForWrite(tx, id)));

        if (sourcesCurrent.some((topic) => topic === null)) {
          throw new Error("Source topic disappeared during merge");
        }

        const currentForums = [
          destinationCurrent.forumId,
          ...sourcesCurrent.flatMap((topic) => (topic === null ? [] : [topic.forumId])),
        ];

        if (
          !(await canMergeAll(tx, input.actorId, input.sessionId ?? null, freshTree, currentForums))
        ) {
          throw new Error("forbidden");
        }

        if (
          republishesHiddenContent(sourcesCurrent) &&
          !(await canRestoreAll(
            tx,
            input.actorId,
            input.sessionId ?? null,
            freshTree,
            currentForums,
          ))
        ) {
          throw new Error("forbidden");
        }

        if (input.title !== undefined) {
          await tx`
            UPDATE core.topics
            SET title = ${title}, slug = ${slugify(title)}, updated_at = now()
            WHERE id = ${destinationCurrent.id}
          `;
        }

        // Park destination positions out of the way, then move each source's rows in with a
        // distinct offset so the unique (topic, position) key never collides mid-flight.
        await tx`
          UPDATE core.posts SET position = position + ${OFFSET}
          WHERE topic_id = ${destinationCurrent.id}
        `;

        const sourceForumCounts = new Map<string, number>();
        const sourcePostCounts = new Map<string, number>();
        // A hidden source's posts were never counted in its forum, so the merge must not
        // subtract them again; they only count once the destination is visible.
        const destinationVisible = destinationCurrent.visibility === "visible";
        let movedVisible = 0;

        for (const [index, source] of sourcesCurrent.entries()) {
          if (source === null) {
            continue;
          }

          const [counts] = (await tx`
            SELECT
              count(*) FILTER (WHERE visibility = 'visible')::int AS visible_posts,
              count(*)::int AS all_posts
            FROM core.posts WHERE topic_id = ${source.id}
          `) as Array<{ visible_posts: number; all_posts: number }>;
          const visible = counts?.visible_posts ?? 0;

          await tx`
            UPDATE core.posts
            SET topic_id = ${destinationCurrent.id},
                position = position + ${OFFSET * (index + 2)}
            WHERE topic_id = ${source.id}
          `;

          // Hidden topics were never counted in their forum, so only a visible source loses a
          // topic; counting every source would subtract the hidden ones a second time.
          if (source.visibility === "visible") {
            sourceForumCounts.set(source.forumId, (sourceForumCounts.get(source.forumId) ?? 0) + 1);
            sourcePostCounts.set(
              source.forumId,
              (sourcePostCounts.get(source.forumId) ?? 0) + visible,
            );
          }

          if (destinationVisible) {
            movedVisible += visible;
          }
        }

        await tx`
          WITH ranked AS (
            SELECT id, row_number() OVER (ORDER BY created_at, id) AS position
            FROM core.posts
            WHERE topic_id = ${destinationCurrent.id}
          )
          UPDATE core.posts p SET position = ranked.position
          FROM ranked WHERE p.id = ranked.id
        `;

        for (const [forumId, count] of sourceForumCounts) {
          await adjustForumTopicCount(tx, forumId, -count);
        }

        for (const [forumId, count] of sourcePostCounts) {
          await adjustForumPostCount(tx, forumId, -count);
        }

        if (movedVisible > 0) {
          await adjustForumPostCount(tx, destinationCurrent.forumId, movedVisible);
        }

        const stubDays = input.stubDays ?? 0;
        const stubExpiry = new Date(Date.now() + stubDays * 24 * 60 * 60 * 1_000);

        for (const source of sourcesCurrent) {
          if (source === null) {
            continue;
          }

          if (stubDays > 0) {
            await tx`
              UPDATE core.topics
              SET moved_to = ${destinationCurrent.id},
                  stub_expires_at = ${stubExpiry},
                  first_post_id = NULL,
                  last_post_id = NULL,
                  last_post_at = NULL,
                  reply_count = 0,
                  locked = true,
                  visibility = 'visible',
                  hold_reason = NULL,
                  updated_at = now()
              WHERE id = ${source.id}
            `;
          } else {
            await deleteTopicRow(tx, source.id);
          }
        }

        await writeModerationLog(tx, {
          actorId: input.actorId,
          action: "topic.merge",
          targetType: "topic",
          targetId: destinationCurrent.id,
          forumId: destinationCurrent.forumId,
          memberId: destinationCurrent.starterId,
          details: {
            sourceTopicIds: sourceIds,
            destinationTopicId: destinationCurrent.id,
            title,
            stubDays: input.stubDays ?? 0,
          },
        });

        await recountTopic(tx, destinationCurrent.id);
        await refreshForumLastPost(tx, destinationCurrent.forumId);

        for (const forumId of unique(currentForums)) {
          if (forumId !== destinationCurrent.forumId) {
            await refreshForumLastPost(tx, forumId);
          }
        }

        return {
          topicId: destinationCurrent.id,
          postIds: [],
          topicIds: [destinationCurrent.id, ...sourceIds],
          forumIds: unique(currentForums.flatMap((forumId) => chain(freshTree, forumId))),
          memberIds: [],
        } satisfies TopicToolsSummary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    if (error instanceof Error && error.message === "forbidden") {
      return { ok: false, code: "forbidden" };
    }

    throw error;
  }
}

/**
 * Moves selected posts out of a topic into a new topic or an existing one. The source and
 * target topic are locked together; positions are renumbered on both sides.
 */
export async function splitTopic(
  sql: SQL,
  input: SplitTopicInput,
): Promise<TopicMutationOutcome<TopicToolsSummary>> {
  const postIds = unique(input.postIds.filter((id) => /^\d+$/.test(id)));

  if (postIds.length === 0 || !/^\d+$/.test(input.sourceTopicId)) {
    return { ok: false, code: "post_not_found" };
  }

  const source = await loadTopicForWrite(sql, input.sourceTopicId);

  if (source === null || source.movedTo !== null) {
    return { ok: false, code: "topic_not_found" };
  }

  const targetTopicId = input.target.kind === "existing" ? input.target.topicId : null;
  const targetTopic = targetTopicId === null ? null : await loadTopicForWrite(sql, targetTopicId);

  if (targetTopicId !== null && (targetTopic === null || targetTopic.movedTo !== null)) {
    return { ok: false, code: "topic_not_found" };
  }

  const targetForumId =
    targetTopic?.forumId ?? (input.target.kind === "new" ? input.target.forumId : "");
  const destination = targetTopicId === null ? await loadForumTarget(sql, targetForumId) : null;

  if (targetTopicId === null && (destination === null || destination.type !== "forum")) {
    return { ok: false, code: "forum_not_found" };
  }

  const newTitle = input.target.kind === "new" ? validTitle(input.target.title, "") : "";

  if (newTitle === null) {
    return { ok: false, code: "invalid_title" };
  }

  const tree = await loadForumTree(sql);
  const forums = [source.forumId, targetForumId];

  if (!(await canSplitAll(sql, input.actorId, input.sessionId ?? null, tree, forums))) {
    return { ok: false, code: "forbidden" };
  }

  if (
    republishesHiddenContent([source]) &&
    !(await canRestoreAll(sql, input.actorId, input.sessionId ?? null, tree, forums))
  ) {
    return { ok: false, code: "forbidden" };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: topicSplitMutation,
      input: { sourceTopicId: source.id, targetTopicId, postIds },
      apply: async (tx) => {
        await lockTopics(tx, [source.id, ...(targetTopicId === null ? [] : [targetTopicId])]);
        const freshTree = await loadForumTree(tx);
        const currentSource = await loadTopicForWrite(tx, source.id);
        const currentTarget =
          targetTopicId === null ? null : await loadTopicForWrite(tx, targetTopicId);

        if (currentSource === null) {
          throw new Error("Source topic disappeared during split");
        }

        if (targetTopicId !== null && currentTarget === null) {
          throw new Error("Target topic disappeared during split");
        }

        const currentTargetForumId =
          currentTarget?.forumId ?? (input.target.kind === "new" ? input.target.forumId : "");

        if (
          !(await canSplitAll(tx, input.actorId, input.sessionId ?? null, freshTree, [
            currentSource.forumId,
            currentTargetForumId,
          ]))
        ) {
          throw new Error("forbidden");
        }

        if (
          republishesHiddenContent([currentSource]) &&
          !(await canRestoreAll(tx, input.actorId, input.sessionId ?? null, freshTree, [
            currentSource.forumId,
            currentTargetForumId,
          ]))
        ) {
          throw new Error("forbidden");
        }

        const rows = (await tx`
          SELECT id::text AS id, author_id::text AS author_id, created_at, visibility
          FROM core.posts
          WHERE topic_id = ${currentSource.id}
            AND id = ANY(${`{${postIds.join(",")}}`}::bigint[])
          ORDER BY position
          FOR UPDATE
        `) as Array<{
          id: string;
          author_id: string | null;
          created_at: Date;
          visibility: string;
        }>;

        if (
          rows.length !== postIds.length ||
          rows.some((row) => row.id === currentSource.firstPostId)
        ) {
          throw new Error("invalid_selection");
        }

        let targetId = currentTarget?.id;

        if (targetId === undefined) {
          if (input.target.kind !== "new") {
            throw new Error("topic_not_found");
          }

          targetId = await insertTopic(tx, {
            forumId: input.target.forumId,
            title: newTitle,
            slug: slugify(newTitle),
            prefixId: null,
            starterId: rows[0]?.author_id ?? input.actorId,
          });
        }

        await tx`
          UPDATE core.posts SET position = position + ${OFFSET}
          WHERE topic_id = ${targetId}
        `;

        for (const [index, row] of rows.entries()) {
          await tx`
            UPDATE core.posts
            SET topic_id = ${targetId}, position = ${OFFSET * 2 + index + 1}
            WHERE id = ${row.id}
          `;
        }

        await tx`
          WITH ranked AS (
            SELECT id, row_number() OVER (ORDER BY position, id) AS position
            FROM core.posts WHERE topic_id = ${targetId}
          )
          UPDATE core.posts p SET position = ranked.position
          FROM ranked WHERE p.id = ranked.id
        `;
        await tx`
          WITH ranked AS (
            SELECT id, row_number() OVER (ORDER BY position, id) AS position
            FROM core.posts WHERE topic_id = ${currentSource.id}
          )
          UPDATE core.posts p SET position = ranked.position
          FROM ranked WHERE p.id = ranked.id
        `;

        const visibleMoved = rows.filter((row) => row.visibility === "visible").length;
        // A hidden source's posts were already removed from its forum's counters; only a
        // visible target adds them back, and a visible source loses the posts it no longer
        // holds.
        const sourceCounted = currentSource.visibility === "visible";
        const targetCounted = currentTarget === null || currentTarget.visibility === "visible";

        if (currentSource.forumId === currentTargetForumId) {
          if (sourceCounted !== targetCounted && visibleMoved > 0) {
            await adjustForumPostCount(
              tx,
              currentTargetForumId,
              targetCounted ? visibleMoved : -visibleMoved,
            );
          }
        } else {
          if (sourceCounted && visibleMoved > 0) {
            await adjustForumPostCount(tx, currentSource.forumId, -visibleMoved);
          }

          if (targetCounted && visibleMoved > 0) {
            await adjustForumPostCount(tx, currentTargetForumId, visibleMoved);
          }
        }

        if (currentTarget === null) {
          await adjustForumTopicCount(tx, currentTargetForumId, 1);
        }

        await writeModerationLog(tx, {
          actorId: input.actorId,
          action: "topic.split",
          targetType: "topic",
          targetId: targetId,
          forumId: currentTargetForumId,
          memberId: rows[0]?.author_id ?? input.actorId,
          details: {
            sourceTopicId: currentSource.id,
            targetTopicId: targetId,
            postIds: rows.map((row) => row.id),
          },
        });

        await recountTopic(tx, currentSource.id);
        await recountTopic(tx, targetId);
        await refreshForumLastPost(tx, currentSource.forumId);
        await refreshForumLastPost(tx, currentTargetForumId);

        return {
          topicId: targetId,
          postIds: rows.map((row) => row.id),
          topicIds: unique([currentSource.id, targetId]),
          forumIds: unique([
            ...chain(freshTree, currentSource.forumId),
            ...chain(freshTree, currentTargetForumId),
          ]),
          memberIds: [],
        } satisfies TopicToolsSummary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    if (error instanceof Error && error.message === "forbidden") {
      return { ok: false, code: "forbidden" };
    }

    if (error instanceof Error && error.message === "invalid_selection") {
      return { ok: false, code: "post_not_found" };
    }

    throw error;
  }
}

export type BulkTarget = "topics" | "posts";
export type BulkTopicAction =
  | "pin"
  | "unpin"
  | "lock"
  | "unlock"
  | "move"
  | "soft_delete"
  | "restore"
  | "approve";
export type BulkPostAction = "soft_delete" | "restore" | "approve";

export interface BulkInput {
  readonly actorId: string;
  readonly target: BulkTarget;
  readonly action: BulkTopicAction | BulkPostAction;
  readonly ids: readonly string[];
  readonly forumId?: string;
  readonly stubDays?: number;
  readonly sessionId?: string | null;
}

export interface BulkResult {
  readonly applied: readonly string[];
}

async function canForTopicAction(
  sql: SQL,
  actorId: string,
  action: BulkTopicAction | BulkPostAction,
  forumId: string,
  tree: ForumTree,
  sessionId: string | null,
): Promise<boolean> {
  const power =
    action === "pin" || action === "unpin"
      ? "pin"
      : action === "lock" || action === "unlock"
        ? "lock"
        : action === "move"
          ? "move"
          : action === "soft_delete"
            ? "soft_delete"
            : action === "restore"
              ? "restore"
              : "approve";

  return can(sql, actorId, power, { forumId, tree, sessionId });
}

/**
 * Bulk actions validate every selected item first, then run the existing single-item mutation
 * so counters, tags and events stay identical to the one-click path.
 */
export async function bulkAction(
  sql: SQL,
  input: BulkInput,
): Promise<TopicMutationOutcome<BulkResult>> {
  const ids = unique(input.ids.filter((id) => /^\d+$/.test(id)));

  if (ids.length === 0) {
    return { ok: false, code: "invalid_request" };
  }

  if (
    (input.target === "posts" &&
      input.action !== "soft_delete" &&
      input.action !== "restore" &&
      input.action !== "approve") ||
    (input.target === "topics" && input.action === undefined)
  ) {
    return { ok: false, code: "invalid_request" };
  }

  const tree = await loadForumTree(sql);
  const topicIds: string[] = [];
  const postIds: string[] = [];

  for (const id of ids) {
    if (input.target === "topics") {
      const topic = await loadTopicForWrite(sql, id);

      if (topic === null || topic.movedTo !== null) {
        return { ok: false, code: "invalid_request" };
      }

      if (
        !(await canForTopicAction(
          sql,
          input.actorId,
          input.action,
          topic.forumId,
          tree,
          input.sessionId ?? null,
        ))
      ) {
        return { ok: false, code: "forbidden" };
      }

      topicIds.push(topic.id);
    } else {
      const post = await loadPostForWrite(sql, id);

      if (post === null) {
        return { ok: false, code: "invalid_request" };
      }

      if (
        !(await canForTopicAction(
          sql,
          input.actorId,
          input.action,
          post.forumId,
          tree,
          input.sessionId ?? null,
        ))
      ) {
        return { ok: false, code: "forbidden" };
      }

      postIds.push(post.id);
    }
  }

  if (input.action === "move" && input.forumId === undefined) {
    return { ok: false, code: "invalid_request" };
  }

  if (input.action === "approve") {
    const approveIds =
      input.target === "topics"
        ? (
            await Promise.all(
              topicIds.map(async (topicId) => (await loadTopicForWrite(sql, topicId))?.firstPostId),
            )
          ).filter((id): id is string => id !== null && id !== undefined)
        : postIds;
    const result = await approveHeldPosts(sql, {
      actorId: input.actorId,
      postIds: approveIds,
      sessionId: input.sessionId ?? null,
    });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === "forbidden" ? "forbidden" : "post_not_found",
      };
    }

    return { ok: true, result: { applied: result.result.postIds } };
  }

  const applied: string[] = [];

  for (const id of input.target === "topics" ? topicIds : postIds) {
    if (input.target === "topics") {
      if (input.action === "pin" || input.action === "unpin") {
        const result = await pin(sql, {
          actorId: input.actorId,
          topicId: id,
          pinned: input.action === "pin",
          sessionId: input.sessionId ?? null,
        });

        if (!result.ok) {
          return result;
        }
      } else if (input.action === "lock" || input.action === "unlock") {
        const result = await lock(sql, {
          actorId: input.actorId,
          topicId: id,
          locked: input.action === "lock",
          sessionId: input.sessionId ?? null,
        });

        if (!result.ok) {
          return result;
        }
      } else if (input.action === "move") {
        const result = await move(sql, {
          actorId: input.actorId,
          topicId: id,
          toForumId: input.forumId ?? "",
          ...(input.stubDays === undefined ? {} : { stubDays: input.stubDays }),
          sessionId: input.sessionId ?? null,
        });

        if (!result.ok) {
          return result;
        }
      } else {
        const result =
          input.action === "soft_delete"
            ? await softDeleteTopic(sql, {
                actorId: input.actorId,
                topicId: id,
                sessionId: input.sessionId ?? null,
              })
            : await restoreTopic(sql, {
                actorId: input.actorId,
                topicId: id,
                sessionId: input.sessionId ?? null,
              });

        if (!result.ok) {
          return result;
        }
      }
    } else {
      const result =
        input.action === "soft_delete"
          ? await softDelete(sql, {
              actorId: input.actorId,
              postId: id,
              sessionId: input.sessionId ?? null,
            })
          : await restore(sql, {
              actorId: input.actorId,
              postId: id,
              sessionId: input.sessionId ?? null,
            });

      if (!result.ok) {
        return result;
      }
    }

    applied.push(id);
  }

  return { ok: true, result: { applied } };
}
