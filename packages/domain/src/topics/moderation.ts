import type { SQL } from "bun";
import { writeModerationLog } from "../moderation/log/repository.ts";
import { runMutation } from "../mutations/index.ts";
import {
  postDeleteMutation,
  postHardDeleteMutation,
  postRestoreMutation,
  type TopicContentSummary,
  topicDeleteMutation,
  topicHardDeleteMutation,
  topicLockMutation,
  topicMoveMutation,
  topicPinMutation,
  topicRestoreMutation,
} from "../mutations/topics.ts";
import type { ForumTree } from "../permissions/tree.ts";
import { loadForumTree } from "../permissions/tree-store.ts";
import {
  actorCanForumAction,
  actorCanModerate,
  adjustForumPostCount,
  adjustForumTopicCount,
  adjustMemberPostCount,
  adjustMemberPostCounts,
  adjustTopicReplyCount,
  deletePostRow,
  deleteTopicRow,
  insertMovedStub,
  loadForumTarget,
  loadPostForWrite,
  loadTopicForWrite,
  lockPostForWrite,
  lockTopicForWrite,
  memberMayDeleteOwnPosts,
  moveTopicRow,
  recountTopic,
  refreshForumLastPost,
  setPostVisibility,
  setTopicLocked,
  setTopicPinned,
  setTopicVisibility,
  visiblePostCount,
  visiblePostCountsByAuthor,
} from "./repository.ts";
import { reject, rejectOutcome, type TopicMutationOutcome } from "./result.ts";

export interface PostTargetInput {
  readonly actorId: string;
  readonly postId: string;
  readonly sessionId?: string | null;
}

export interface TopicTargetInput {
  readonly actorId: string;
  readonly topicId: string;
  readonly sessionId?: string | null;
}

export interface HardDeleteInput {
  readonly actorId: string;
  readonly postId?: string;
  readonly topicId?: string;
  readonly sessionId?: string | null;
}

export interface MoveInput extends TopicTargetInput {
  readonly toForumId: string;
  /** Leave a redirect stub in the source forum for this many days. */
  readonly stubDays?: number;
}

function forumChain(tree: ForumTree, forumId: string): readonly string[] {
  return [...tree.ancestors(forumId).map((node) => node.id), forumId];
}

function uniqueIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)];
}

export async function softDelete(
  sql: SQL,
  input: PostTargetInput,
): Promise<TopicMutationOutcome<TopicContentSummary>> {
  const post = await loadPostForWrite(sql, input.postId);

  if (post === null) {
    return { ok: false, code: "post_not_found" };
  }

  const tree = await loadForumTree(sql);
  const readable = await actorCanForumAction(
    sql,
    input.actorId,
    "read",
    post.forumId,
    tree,
    input.sessionId ?? null,
  );
  const isAuthor = post.authorId !== null && post.authorId === input.actorId;
  const allowed =
    readable &&
    ((isAuthor && (await memberMayDeleteOwnPosts(sql, input.actorId))) ||
      (await actorCanModerate(
        sql,
        input.actorId,
        "soft_delete",
        post.forumId,
        tree,
        input.sessionId ?? null,
      )));

  if (!allowed) {
    return { ok: false, code: "forbidden" };
  }

  const summary: TopicContentSummary = {
    topicId: post.topicId,
    forumIds: forumChain(tree, post.forumId),
    memberIds: post.authorId === null ? [] : [post.authorId],
  };

  if (post.visibility !== "visible") {
    return { ok: true, result: summary };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: postDeleteMutation,
      input: { postId: input.postId },
      apply: async (tx) => {
        await lockTopicForWrite(tx, post.topicId);
        const current = await lockPostForWrite(tx, input.postId);

        if (current === null) {
          reject("post_not_found");
        }

        const freshTree = await loadForumTree(tx);
        const currentIsAuthor = current.authorId !== null && current.authorId === input.actorId;
        const readable = await actorCanForumAction(
          tx,
          input.actorId,
          "read",
          current.forumId,
          freshTree,
          input.sessionId ?? null,
        );
        const allowed =
          readable &&
          ((currentIsAuthor && (await memberMayDeleteOwnPosts(tx, input.actorId))) ||
            (await actorCanModerate(
              tx,
              input.actorId,
              "soft_delete",
              current.forumId,
              freshTree,
              input.sessionId ?? null,
            )));

        if (!allowed) {
          reject("forbidden");
        }

        if (current.visibility === "visible") {
          await setPostVisibility(tx, current.id, "soft_deleted");
          await writeModerationLog(tx, {
            actorId: input.actorId,
            action: "post.delete",
            targetType: "post",
            targetId: current.id,
            forumId: current.forumId,
            memberId: current.authorId,
            details: { topicId: current.topicId, authorAction: currentIsAuthor },
          });
          await adjustForumPostCount(tx, current.forumId, -1);

          if (current.authorId !== null) {
            await adjustMemberPostCount(tx, current.authorId, -1);
          }

          if (current.position > 1) {
            await adjustTopicReplyCount(tx, current.topicId, -1);
          }

          await recountTopic(tx, current.topicId);
          await refreshForumLastPost(tx, current.forumId, current.id);
        } else {
          await setPostVisibility(tx, current.id, "soft_deleted");
        }

        return summary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    const rejected = rejectOutcome(error);

    if (rejected !== null) {
      return rejected;
    }

    throw error;
  }
}

export async function restore(
  sql: SQL,
  input: PostTargetInput,
): Promise<TopicMutationOutcome<TopicContentSummary>> {
  const post = await loadPostForWrite(sql, input.postId);

  if (post === null) {
    return { ok: false, code: "post_not_found" };
  }

  const tree = await loadForumTree(sql);
  const power = post.visibility === "unapproved" ? "approve" : "restore";

  if (
    !(await actorCanModerate(
      sql,
      input.actorId,
      power,
      post.forumId,
      tree,
      input.sessionId ?? null,
    ))
  ) {
    return { ok: false, code: "forbidden" };
  }

  const summary: TopicContentSummary = {
    topicId: post.topicId,
    forumIds: forumChain(tree, post.forumId),
    memberIds: post.authorId === null ? [] : [post.authorId],
  };

  if (post.visibility === "visible") {
    return { ok: true, result: summary };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: postRestoreMutation,
      input: { postId: input.postId },
      apply: async (tx) => {
        await lockTopicForWrite(tx, post.topicId);
        const current = await lockPostForWrite(tx, input.postId);

        if (current === null) {
          reject("post_not_found");
        }

        if (current.visibility !== "visible") {
          const currentPower = current.visibility === "unapproved" ? "approve" : "restore";
          const freshTree = await loadForumTree(tx);

          if (
            !(await actorCanModerate(
              tx,
              input.actorId,
              currentPower,
              current.forumId,
              freshTree,
              input.sessionId ?? null,
            ))
          ) {
            reject("forbidden");
          }

          await setPostVisibility(tx, current.id, "visible");
          await writeModerationLog(tx, {
            actorId: input.actorId,
            action: current.visibility === "unapproved" ? "post.approve" : "post.restore",
            targetType: "post",
            targetId: current.id,
            forumId: current.forumId,
            memberId: current.authorId,
            details: { topicId: current.topicId },
          });
          await adjustForumPostCount(tx, current.forumId, 1);

          if (current.authorId !== null) {
            await adjustMemberPostCount(tx, current.authorId, 1);
          }

          if (current.position > 1) {
            await adjustTopicReplyCount(tx, current.topicId, 1);
          }

          await recountTopic(tx, current.topicId);
          await refreshForumLastPost(tx, current.forumId);
        }

        return summary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    const rejected = rejectOutcome(error);

    if (rejected !== null) {
      return rejected;
    }

    throw error;
  }
}

/**
 * Soft-deletes a whole topic by hiding the topic row, leaving each post's own visibility
 * untouched so a later restore returns the exact topic, including replies that were already
 * deleted individually. Public readers and counters drop the topic as one unit.
 */
export async function softDeleteTopic(
  sql: SQL,
  input: TopicTargetInput,
): Promise<TopicMutationOutcome<TopicContentSummary>> {
  const topic = await loadTopicForWrite(sql, input.topicId);

  if (topic === null) {
    return { ok: false, code: "topic_not_found" };
  }

  const tree = await loadForumTree(sql);

  if (
    !(await actorCanModerate(
      sql,
      input.actorId,
      "soft_delete",
      topic.forumId,
      tree,
      input.sessionId ?? null,
    ))
  ) {
    return { ok: false, code: "forbidden" };
  }

  const summary: TopicContentSummary = {
    topicId: topic.id,
    forumIds: forumChain(tree, topic.forumId),
    memberIds: [],
  };

  if (topic.visibility === "soft_deleted") {
    return { ok: true, result: summary };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: topicDeleteMutation,
      input: { topicId: input.topicId },
      apply: async (tx) => {
        const current = await lockTopicForWrite(tx, input.topicId);

        if (current === null) {
          reject("topic_not_found");
        }

        if (current.visibility === "soft_deleted") {
          return summary;
        }

        const freshTree = await loadForumTree(tx);

        if (
          !(await actorCanModerate(
            tx,
            input.actorId,
            "soft_delete",
            current.forumId,
            freshTree,
            input.sessionId ?? null,
          ))
        ) {
          reject("forbidden");
        }

        const postCount = await visiblePostCount(tx, current.id);
        const authorCounts = await visiblePostCountsByAuthor(tx, current.id);

        await setTopicVisibility(tx, current.id, "soft_deleted");
        await adjustForumPostCount(tx, current.forumId, -postCount);
        await adjustForumTopicCount(tx, current.forumId, -1);
        await adjustMemberPostCounts(tx, authorCounts, -1);
        await refreshForumLastPost(tx, current.forumId);
        await writeModerationLog(tx, {
          actorId: input.actorId,
          action: "topic.delete",
          targetType: "topic",
          targetId: current.id,
          forumId: current.forumId,
          memberId: current.starterId,
          details: { title: current.title, postCount },
        });

        return {
          topicId: current.id,
          forumIds: forumChain(freshTree, current.forumId),
          memberIds: [...authorCounts.keys()],
        } satisfies TopicContentSummary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    const rejected = rejectOutcome(error);

    if (rejected !== null) {
      return rejected;
    }

    throw error;
  }
}

/** Restores a topic hidden by `softDeleteTopic` and puts its visible posts back in counters. */
export async function restoreTopic(
  sql: SQL,
  input: TopicTargetInput,
): Promise<TopicMutationOutcome<TopicContentSummary>> {
  const topic = await loadTopicForWrite(sql, input.topicId);

  if (topic === null) {
    return { ok: false, code: "topic_not_found" };
  }

  const tree = await loadForumTree(sql);

  if (
    !(await actorCanModerate(
      sql,
      input.actorId,
      "restore",
      topic.forumId,
      tree,
      input.sessionId ?? null,
    ))
  ) {
    return { ok: false, code: "forbidden" };
  }

  const summary: TopicContentSummary = {
    topicId: topic.id,
    forumIds: forumChain(tree, topic.forumId),
    memberIds: [],
  };

  if (topic.visibility !== "soft_deleted") {
    return { ok: true, result: summary };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: topicRestoreMutation,
      input: { topicId: input.topicId },
      apply: async (tx) => {
        const current = await lockTopicForWrite(tx, input.topicId);

        if (current === null) {
          reject("topic_not_found");
        }

        if (current.visibility !== "soft_deleted") {
          return summary;
        }

        const freshTree = await loadForumTree(tx);

        if (
          !(await actorCanModerate(
            tx,
            input.actorId,
            "restore",
            current.forumId,
            freshTree,
            input.sessionId ?? null,
          ))
        ) {
          reject("forbidden");
        }

        const postCount = await visiblePostCount(tx, current.id);
        const authorCounts = await visiblePostCountsByAuthor(tx, current.id);

        await setTopicVisibility(tx, current.id, "visible");
        await adjustForumPostCount(tx, current.forumId, postCount);
        await adjustForumTopicCount(tx, current.forumId, 1);
        await adjustMemberPostCounts(tx, authorCounts, 1);
        await refreshForumLastPost(tx, current.forumId);
        await writeModerationLog(tx, {
          actorId: input.actorId,
          action: "topic.restore",
          targetType: "topic",
          targetId: current.id,
          forumId: current.forumId,
          memberId: current.starterId,
          details: { title: current.title, postCount },
        });

        return {
          topicId: current.id,
          forumIds: forumChain(freshTree, current.forumId),
          memberIds: [...authorCounts.keys()],
        } satisfies TopicContentSummary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    const rejected = rejectOutcome(error);

    if (rejected !== null) {
      return rejected;
    }

    throw error;
  }
}

async function hardDeletePost(
  sql: SQL,
  input: PostTargetInput,
): Promise<TopicMutationOutcome<TopicContentSummary>> {
  const post = await loadPostForWrite(sql, input.postId);

  if (post === null) {
    return { ok: false, code: "post_not_found" };
  }

  if (post.position === 1) {
    return { ok: false, code: "first_post_requires_topic_delete" };
  }

  const tree = await loadForumTree(sql);

  if (
    !(await actorCanModerate(
      sql,
      input.actorId,
      "hard_delete",
      post.forumId,
      tree,
      input.sessionId ?? null,
    ))
  ) {
    return { ok: false, code: "forbidden" };
  }

  const summary: TopicContentSummary = {
    topicId: post.topicId,
    forumIds: forumChain(tree, post.forumId),
    memberIds: post.authorId === null ? [] : [post.authorId],
  };

  try {
    const result = await runMutation({
      sql,
      mutation: postHardDeleteMutation,
      input: { postId: input.postId },
      apply: async (tx) => {
        await lockTopicForWrite(tx, post.topicId);
        const current = await lockPostForWrite(tx, input.postId);

        if (current === null) {
          reject("post_not_found");
        }

        if (current.position === 1) {
          reject("first_post_requires_topic_delete");
        }

        const freshTree = await loadForumTree(tx);

        if (
          !(await actorCanModerate(
            tx,
            input.actorId,
            "hard_delete",
            current.forumId,
            freshTree,
            input.sessionId ?? null,
          ))
        ) {
          reject("forbidden");
        }

        await deletePostRow(tx, current.id);
        await writeModerationLog(tx, {
          actorId: input.actorId,
          action: "post.hard_delete",
          targetType: "post",
          targetId: current.id,
          forumId: current.forumId,
          memberId: current.authorId,
          details: { topicId: current.topicId },
        });

        if (current.visibility === "visible") {
          await adjustForumPostCount(tx, current.forumId, -1);

          if (current.authorId !== null) {
            await adjustMemberPostCount(tx, current.authorId, -1);
          }

          if (current.position > 1) {
            await adjustTopicReplyCount(tx, current.topicId, -1);
          }

          await recountTopic(tx, current.topicId);
          await refreshForumLastPost(tx, current.forumId, current.id);
        }

        return summary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    const rejected = rejectOutcome(error);

    if (rejected !== null) {
      return rejected;
    }

    throw error;
  }
}

async function hardDeleteTopic(
  sql: SQL,
  input: TopicTargetInput,
): Promise<TopicMutationOutcome<TopicContentSummary>> {
  const topic = await loadTopicForWrite(sql, input.topicId);

  if (topic === null) {
    return { ok: false, code: "topic_not_found" };
  }

  const tree = await loadForumTree(sql);

  if (
    !(await actorCanModerate(
      sql,
      input.actorId,
      "hard_delete",
      topic.forumId,
      tree,
      input.sessionId ?? null,
    ))
  ) {
    return { ok: false, code: "forbidden" };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: topicHardDeleteMutation,
      input: { topicId: input.topicId },
      apply: async (tx) => {
        const current = await lockTopicForWrite(tx, input.topicId);

        if (current === null) {
          reject("topic_not_found");
        }

        const freshTree = await loadForumTree(tx);

        if (
          !(await actorCanModerate(
            tx,
            input.actorId,
            "hard_delete",
            current.forumId,
            freshTree,
            input.sessionId ?? null,
          ))
        ) {
          reject("forbidden");
        }

        const postCount = await visiblePostCount(tx, current.id);
        const authorCounts = await visiblePostCountsByAuthor(tx, current.id);

        await deleteTopicRow(tx, current.id);
        await writeModerationLog(tx, {
          actorId: input.actorId,
          action: "topic.hard_delete",
          targetType: "topic",
          targetId: current.id,
          forumId: current.forumId,
          memberId: current.starterId,
          details: { title: current.title },
        });

        // A redirect stub and a hidden topic never contributed to the source forum's counts.
        const counted = current.movedTo === null && current.visibility === "visible";

        if (counted) {
          await adjustForumTopicCount(tx, current.forumId, -1);

          if (postCount > 0) {
            await adjustForumPostCount(tx, current.forumId, -postCount);
            await adjustMemberPostCounts(tx, authorCounts, -1);
            await refreshForumLastPost(tx, current.forumId, current.lastPostId);
          }
        }

        return {
          topicId: current.id,
          forumIds: forumChain(tree, current.forumId),
          memberIds: counted ? [...authorCounts.keys()] : [],
        } satisfies TopicContentSummary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    const rejected = rejectOutcome(error);

    if (rejected !== null) {
      return rejected;
    }

    throw error;
  }
}

/** Deletes a post, or a whole topic when `topicId` is given without `postId`. */
export async function hardDelete(
  sql: SQL,
  input: HardDeleteInput,
): Promise<TopicMutationOutcome<TopicContentSummary>> {
  if (input.postId !== undefined) {
    return hardDeletePost(sql, {
      actorId: input.actorId,
      postId: input.postId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    });
  }

  if (input.topicId !== undefined) {
    return hardDeleteTopic(sql, {
      actorId: input.actorId,
      topicId: input.topicId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    });
  }

  return { ok: false, code: "post_not_found" };
}

export async function lock(
  sql: SQL,
  input: TopicTargetInput & { readonly locked: boolean },
): Promise<TopicMutationOutcome<TopicContentSummary>> {
  const topic = await loadTopicForWrite(sql, input.topicId);

  if (topic === null || topic.movedTo !== null) {
    return { ok: false, code: "topic_not_found" };
  }

  const tree = await loadForumTree(sql);

  if (
    !(await actorCanModerate(
      sql,
      input.actorId,
      "lock",
      topic.forumId,
      tree,
      input.sessionId ?? null,
    ))
  ) {
    return { ok: false, code: "forbidden" };
  }

  const summary: TopicContentSummary = {
    topicId: topic.id,
    forumIds: forumChain(tree, topic.forumId),
    memberIds: [],
  };

  const result = await runMutation({
    sql,
    mutation: topicLockMutation,
    input: { topicId: topic.id, locked: input.locked },
    apply: async (tx) => {
      await setTopicLocked(tx, topic.id, input.locked);
      await writeModerationLog(tx, {
        actorId: input.actorId,
        action: "topic.lock",
        targetType: "topic",
        targetId: topic.id,
        forumId: topic.forumId,
        memberId: topic.starterId,
        details: { locked: input.locked },
      });
      return summary;
    },
  });

  return { ok: true, result };
}

export async function pin(
  sql: SQL,
  input: TopicTargetInput & { readonly pinned: boolean },
): Promise<TopicMutationOutcome<TopicContentSummary>> {
  const topic = await loadTopicForWrite(sql, input.topicId);

  if (topic === null || topic.movedTo !== null) {
    return { ok: false, code: "topic_not_found" };
  }

  const tree = await loadForumTree(sql);

  if (
    !(await actorCanModerate(
      sql,
      input.actorId,
      "pin",
      topic.forumId,
      tree,
      input.sessionId ?? null,
    ))
  ) {
    return { ok: false, code: "forbidden" };
  }

  const summary: TopicContentSummary = {
    topicId: topic.id,
    forumIds: forumChain(tree, topic.forumId),
    memberIds: [],
  };

  const result = await runMutation({
    sql,
    mutation: topicPinMutation,
    input: { topicId: topic.id, pinned: input.pinned },
    apply: async (tx) => {
      await setTopicPinned(tx, topic.id, input.pinned);
      await writeModerationLog(tx, {
        actorId: input.actorId,
        action: "topic.pin",
        targetType: "topic",
        targetId: topic.id,
        forumId: topic.forumId,
        memberId: topic.starterId,
        details: { pinned: input.pinned },
      });
      return summary;
    },
  });

  return { ok: true, result };
}

export async function move(
  sql: SQL,
  input: MoveInput,
): Promise<TopicMutationOutcome<TopicContentSummary>> {
  const topic = await loadTopicForWrite(sql, input.topicId);

  if (topic === null || topic.movedTo !== null) {
    return { ok: false, code: "topic_not_found" };
  }

  const destination = await loadForumTarget(sql, input.toForumId);

  if (destination === null || destination.type !== "forum") {
    return { ok: false, code: "forum_not_found" };
  }

  const tree = await loadForumTree(sql);

  if (
    !(await actorCanModerate(
      sql,
      input.actorId,
      "move",
      topic.forumId,
      tree,
      input.sessionId ?? null,
    ))
  ) {
    return { ok: false, code: "forbidden" };
  }

  if (
    !(await actorCanModerate(
      sql,
      input.actorId,
      "move",
      destination.id,
      tree,
      input.sessionId ?? null,
    ))
  ) {
    return { ok: false, code: "forbidden" };
  }

  if (destination.id === topic.forumId) {
    return {
      ok: true,
      result: {
        topicId: topic.id,
        forumIds: forumChain(tree, topic.forumId),
        memberIds: [],
      },
    };
  }

  const stubDays = input.stubDays ?? 0;

  try {
    const result = await runMutation({
      sql,
      mutation: topicMoveMutation,
      input: { topicId: topic.id, toForumId: destination.id },
      apply: async (tx) => {
        const current = await lockTopicForWrite(tx, input.topicId);

        if (current === null || current.movedTo !== null) {
          reject("topic_not_found");
        }

        const freshTree = await loadForumTree(tx);
        const freshDestination = await loadForumTarget(tx, input.toForumId);

        if (freshDestination === null || freshDestination.type !== "forum") {
          reject("forum_not_found");
        }

        if (
          !(await actorCanModerate(
            tx,
            input.actorId,
            "move",
            current.forumId,
            freshTree,
            input.sessionId ?? null,
          )) ||
          !(await actorCanModerate(
            tx,
            input.actorId,
            "move",
            freshDestination.id,
            freshTree,
            input.sessionId ?? null,
          ))
        ) {
          reject("forbidden");
        }

        const postCount = await visiblePostCount(tx, current.id);
        // A hidden topic was never in its source forum's counters and does not join the
        // destination's until it is restored.
        const counted = current.visibility === "visible";

        if (counted) {
          await adjustForumTopicCount(tx, current.forumId, -1);
          await adjustForumPostCount(tx, current.forumId, -postCount);
        }

        await moveTopicRow(tx, current.id, freshDestination.id);
        await writeModerationLog(tx, {
          actorId: input.actorId,
          action: "topic.move",
          targetType: "topic",
          targetId: current.id,
          forumId: freshDestination.id,
          memberId: current.starterId,
          details: {
            fromForumId: current.forumId,
            toForumId: freshDestination.id,
            stubDays,
          },
        });

        if (counted) {
          await adjustForumTopicCount(tx, freshDestination.id, 1);
          await adjustForumPostCount(tx, freshDestination.id, postCount);
        }

        if (stubDays > 0) {
          await insertMovedStub(tx, {
            topic: current,
            forumId: current.forumId,
            stubExpiresAt: new Date(Date.now() + stubDays * 24 * 60 * 60 * 1_000),
          });
        }

        await refreshForumLastPost(tx, current.forumId, current.lastPostId);
        await refreshForumLastPost(tx, freshDestination.id);

        return {
          topicId: current.id,
          forumIds: uniqueIds([
            ...forumChain(tree, current.forumId),
            ...forumChain(tree, freshDestination.id),
          ]),
          memberIds: [],
        } satisfies TopicContentSummary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    const rejected = rejectOutcome(error);

    if (rejected !== null) {
      return rejected;
    }

    throw error;
  }
}
