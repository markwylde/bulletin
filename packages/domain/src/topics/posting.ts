import type { RenderResult, ReplaceWords } from "@bulletin/content";
import { saveContent } from "@bulletin/content";
import type { SQL } from "bun";
import { redactQuoteSnapshotsInTransaction } from "../content/quotes.ts";
import { loadContentRenderDependencies } from "../content/rendering.ts";
import { runMutation } from "../mutations/index.ts";
import {
  type PostEditSummary,
  postEditMutation,
  postReplyMutation,
  type TopicWriteResult,
  topicStartMutation,
} from "../mutations/topics.ts";
import type { ForumTree } from "../permissions/tree.ts";
import { loadForumTree } from "../permissions/tree-store.ts";
import { type PollInput, validPollInput } from "../polls/index.ts";
import { insertPoll } from "../polls/repository.ts";
import { slugify } from "../urls/index.ts";
import {
  actorCanForumAction,
  actorCanModerate,
  actorCanUsePrefix,
  completeNewTopic,
  createPostQuotePipeline,
  editWindowMinutes,
  insertPost,
  insertPostRevision,
  insertTopic,
  loadForumTarget,
  loadPostForWrite,
  loadTopicForWrite,
  lockPostForWrite,
  lockTopicForWrite,
  prefixEnabledForForum,
  protectPostRevisions,
  recordReply,
  updatePostRendering,
} from "./repository.ts";
import {
  reject,
  rejectOutcome,
  type TopicMutationCode,
  type TopicMutationOutcome,
} from "./result.ts";

export interface PostWriteOptions {
  /** The author's evaluated `mentions` flag (ADR 0010); mentions render only when true. */
  readonly mentions?: boolean;
  /** The board's replace-word list; folded into `render_version` (ADR 0007). */
  readonly replaceWords?: ReplaceWords;
}

export interface StartTopicInput {
  readonly actorId: string;
  readonly forumId: string;
  readonly title: string;
  readonly bodyMd: string;
  readonly prefixId?: string | null;
  readonly poll?: PollInput;
}

export interface ReplyInput {
  readonly actorId: string;
  readonly topicId: string;
  readonly bodyMd: string;
}

export interface EditPostInput {
  readonly actorId: string;
  readonly postId: string;
  readonly sessionId?: string | null;
  readonly bodyMd: string;
  /** Defaults to true for a moderator editing someone else's post (ADR 0007). */
  readonly redact?: boolean;
}

function validTitle(value: string): string | null {
  const title = value.trim();
  return title.length >= 3 && title.length <= 150 ? title : null;
}

function validBody(value: string): string | null {
  return value.trim() === "" ? null : value;
}

function forumChain(tree: ForumTree, forumId: string): readonly string[] {
  return [...tree.ancestors(forumId).map((node) => node.id), forumId];
}

async function savePostContent(
  tx: SQL,
  input: {
    readonly bodyMd: string;
    readonly authorId: string;
    readonly forumId: string;
    readonly tree: ForumTree;
    readonly options: PostWriteOptions;
  },
): Promise<RenderResult> {
  const dependencies = await loadContentRenderDependencies(tx);

  return saveContent(input.bodyMd, {
    profile: "post",
    context: { kind: "forum_post", forumId: input.forumId },
    authorId: input.authorId,
    emoticons: dependencies.emoticons,
    ...(input.options.mentions === false ? {} : { mentions: dependencies.mentions }),
    embeds: dependencies.embeds,
    quotes: createPostQuotePipeline(tx, input.tree),
    ...(input.options.replaceWords === undefined
      ? {}
      : { replaceWords: input.options.replaceWords }),
  });
}

export async function startTopic(
  sql: SQL,
  input: StartTopicInput,
  options: PostWriteOptions = {},
): Promise<TopicMutationOutcome<TopicWriteResult>> {
  const title = validTitle(input.title);
  const bodyMd = validBody(input.bodyMd);

  if (title === null) {
    return { ok: false, code: "invalid_title" };
  }

  if (bodyMd === null) {
    return { ok: false, code: "invalid_body" };
  }

  if (input.poll !== undefined && !validPollInput(input.poll)) {
    return { ok: false, code: "invalid_poll" };
  }

  const forum = await loadForumTarget(sql, input.forumId);

  if (forum === null || forum.type !== "forum") {
    return { ok: false, code: "forum_not_found" };
  }

  const tree = await loadForumTree(sql);

  if (!(await actorCanForumAction(sql, input.actorId, "start", forum.id, tree))) {
    return { ok: false, code: "forbidden" };
  }

  const prefixId = input.prefixId ?? null;

  if (prefixId === null) {
    if (forum.prefixMode === "required") {
      return { ok: false, code: "prefix_required" };
    }
  } else {
    const enabled = await prefixEnabledForForum(sql, forum.id, prefixId);

    if (!enabled || !(await actorCanUsePrefix(sql, input.actorId, prefixId))) {
      return { ok: false, code: "invalid_prefix" };
    }
  }

  const slug = slugify(title);

  try {
    const result = await runMutation({
      sql,
      mutation: topicStartMutation,
      input: { forumId: forum.id, authorId: input.actorId },
      apply: async (tx) => {
        const rendered = await savePostContent(tx, {
          bodyMd,
          authorId: input.actorId,
          forumId: forum.id,
          tree,
          options,
        });
        const topicId = await insertTopic(tx, {
          forumId: forum.id,
          title,
          slug,
          prefixId,
          starterId: input.actorId,
        });
        const post = await insertPost(tx, {
          topicId,
          authorId: input.actorId,
          bodyMd: rendered.bodyMd,
          bodyHtml: rendered.bodyHtml,
          bodyText: rendered.bodyText,
          renderVersion: rendered.renderVersion,
          sanitiserVersion: rendered.sanitiserVersion,
          quotedForumIds: rendered.quotedForumIds,
        });

        if (input.poll !== undefined) {
          await insertPoll(tx, topicId, input.poll);
        }

        await completeNewTopic(tx, {
          topicId,
          forumId: forum.id,
          postId: post.id,
          authorId: input.actorId,
          createdAt: post.createdAt,
        });

        return {
          topicId,
          postId: post.id,
          position: post.position,
          forumIds: forumChain(tree, forum.id),
          memberIds: [input.actorId],
        } satisfies TopicWriteResult;
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

export async function reply(
  sql: SQL,
  input: ReplyInput,
  options: PostWriteOptions = {},
): Promise<TopicMutationOutcome<TopicWriteResult>> {
  const bodyMd = validBody(input.bodyMd);

  if (bodyMd === null) {
    return { ok: false, code: "invalid_body" };
  }

  const topic = await loadTopicForWrite(sql, input.topicId);

  if (topic === null || topic.movedTo !== null) {
    return { ok: false, code: "topic_not_found" };
  }

  const tree = await loadForumTree(sql);

  if (!(await actorCanForumAction(sql, input.actorId, "reply", topic.forumId, tree))) {
    return { ok: false, code: "forbidden" };
  }

  const mayReplyWhenLocked = await actorCanModerate(
    sql,
    input.actorId,
    "lock",
    topic.forumId,
    tree,
  );

  try {
    const result = await runMutation({
      sql,
      mutation: postReplyMutation,
      input: { topicId: input.topicId, authorId: input.actorId },
      apply: async (tx) => {
        // The topic lock serialises position assignment and every counter update (ADR 0006).
        const current = await lockTopicForWrite(tx, input.topicId);

        if (current === null || current.movedTo !== null) {
          reject("topic_not_found");
        }

        if (current.locked && !mayReplyWhenLocked) {
          reject("locked");
        }

        const rendered = await savePostContent(tx, {
          bodyMd,
          authorId: input.actorId,
          forumId: current.forumId,
          tree,
          options,
        });
        const post = await insertPost(tx, {
          topicId: current.id,
          authorId: input.actorId,
          bodyMd: rendered.bodyMd,
          bodyHtml: rendered.bodyHtml,
          bodyText: rendered.bodyText,
          renderVersion: rendered.renderVersion,
          sanitiserVersion: rendered.sanitiserVersion,
          quotedForumIds: rendered.quotedForumIds,
        });

        await recordReply(tx, {
          topicId: current.id,
          forumId: current.forumId,
          postId: post.id,
          authorId: input.actorId,
          createdAt: post.createdAt,
        });

        return {
          topicId: current.id,
          postId: post.id,
          position: post.position,
          forumIds: forumChain(tree, current.forumId),
          memberIds: [input.actorId],
        } satisfies TopicWriteResult;
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

export async function editPost(
  sql: SQL,
  input: EditPostInput,
  options: PostWriteOptions = {},
): Promise<TopicMutationOutcome<PostEditSummary>> {
  const bodyMd = validBody(input.bodyMd);

  if (bodyMd === null) {
    return { ok: false, code: "invalid_body" };
  }

  const post = await loadPostForWrite(sql, input.postId);

  if (post === null || post.visibility !== "visible") {
    return { ok: false, code: "post_not_found" };
  }

  const tree = await loadForumTree(sql);

  if (
    !(await actorCanForumAction(
      sql,
      input.actorId,
      "read",
      post.forumId,
      tree,
      input.sessionId ?? null,
    ))
  ) {
    return { ok: false, code: "forbidden" };
  }

  const isAuthor = post.authorId !== null && post.authorId === input.actorId;
  const canModerate = await actorCanModerate(
    sql,
    input.actorId,
    "edit",
    post.forumId,
    tree,
    input.sessionId ?? null,
  );

  if (isAuthor) {
    const windowMinutes = await editWindowMinutes(sql, input.actorId);
    const ageMinutes = (Date.now() - post.createdAt.getTime()) / 60_000;

    if (windowMinutes > 0 && ageMinutes > windowMinutes) {
      return { ok: false, code: "edit_window_expired" };
    }
  } else if (!canModerate) {
    return { ok: false, code: "forbidden" };
  }

  const redact = input.redact ?? !isAuthor;
  const mayRedact = redact && canModerate && !isAuthor;

  try {
    const result = await runMutation({
      sql,
      mutation: postEditMutation,
      input: { topicId: post.topicId, postId: post.id, redacted: mayRedact },
      apply: async (tx) => {
        const current = await lockPostForWrite(tx, input.postId);

        if (current === null || current.visibility !== "visible") {
          reject("post_not_found");
        }

        await insertPostRevision(tx, current);

        const rendered = await savePostContent(tx, {
          bodyMd,
          authorId: input.actorId,
          forumId: current.forumId,
          tree,
          options,
        });

        await updatePostRendering(tx, {
          postId: current.id,
          bodyMd: rendered.bodyMd,
          bodyHtml: rendered.bodyHtml,
          bodyText: rendered.bodyText,
          renderVersion: rendered.renderVersion,
          sanitiserVersion: rendered.sanitiserVersion,
          quotedForumIds: rendered.quotedForumIds,
          editedBy: input.actorId,
        });

        if (mayRedact) {
          await protectPostRevisions(tx, current.id);
          await redactQuoteSnapshotsInTransaction(tx, { kind: "post", id: current.id });
        }

        return {
          topicId: current.topicId,
          postId: current.id,
          redacted: mayRedact,
        } satisfies PostEditSummary;
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

export type { TopicMutationCode };
