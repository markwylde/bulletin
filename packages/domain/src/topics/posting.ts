import {
  ContentError,
  countContentImages,
  countContentLinks,
  type RenderResult,
  type ReplaceWords,
  saveContent,
} from "@bulletin/content";
import type { SQL } from "bun";
import { syncPostAttachments } from "../attachments/store.ts";
import { redactQuoteSnapshotsInTransaction } from "../content/quotes.ts";
import { loadContentRenderDependencies } from "../content/rendering.ts";
import { emit } from "../events/outbox.ts";
import {
  bodyHash,
  evaluateSpam,
  isBlockedText,
  loadBlockWords,
  loadReplaceWords,
  readLinkPolicy,
  recordDuplicate,
} from "../filters/repository.ts";
import { autoFollowTopic } from "../follows/repository.ts";
import { decideApproval } from "../moderation/approval/repository.ts";
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
import { postingBlockedByWarning } from "../warnings/repository.ts";
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
  readonly sessionId?: string | null;
  readonly title: string;
  readonly bodyMd: string;
  readonly prefixId?: string | null;
  readonly poll?: PollInput;
  /** False when the `follows` flag is off for the actor. */
  readonly autoFollow?: boolean;
}

export interface ReplyInput {
  readonly actorId: string;
  readonly topicId: string;
  readonly sessionId?: string | null;
  readonly bodyMd: string;
  /** False when the `follows` flag is off for the actor. */
  readonly autoFollow?: boolean;
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
    readonly sessionId: string | null;
    readonly options: PostWriteOptions;
  },
): Promise<RenderResult> {
  const [dependencies, replaceWords, blocked] = await Promise.all([
    loadContentRenderDependencies(tx),
    loadReplaceWords(tx),
    loadBlockWords(tx),
  ]);
  const overrideReplace = input.options.replaceWords ?? replaceWords;

  return saveContent(input.bodyMd, {
    profile: "post",
    context: { kind: "forum_post", forumId: input.forumId },
    authorId: input.authorId,
    emoticons: dependencies.emoticons,
    ...(input.options.mentions === false ? {} : { mentions: dependencies.mentions }),
    embeds: dependencies.embeds,
    quotes: createPostQuotePipeline(tx, input.tree, input.sessionId),
    replaceWords: overrideReplace,
    checks: {
      blockedWords: blocked.whole,
      blockedAnyWords: blocked.any,
    },
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

  const blockedBefore = await postingBlockedByWarning(sql, input.actorId);

  if (blockedBefore !== null) {
    return { ok: false, code: blockedBefore };
  }

  if (await isBlockedText(sql, title)) {
    return { ok: false, code: "blocked_word" };
  }

  const forum = await loadForumTarget(sql, input.forumId);

  if (forum === null || forum.type !== "forum") {
    return { ok: false, code: "forum_not_found" };
  }

  const tree = await loadForumTree(sql);

  if (
    !(await actorCanForumAction(
      sql,
      input.actorId,
      "read",
      forum.id,
      tree,
      input.sessionId ?? null,
    )) ||
    !(await actorCanForumAction(
      sql,
      input.actorId,
      "start",
      forum.id,
      tree,
      input.sessionId ?? null,
    ))
  ) {
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
        const freshTree = await loadForumTree(tx);

        if (
          !(await actorCanForumAction(
            tx,
            input.actorId,
            "read",
            forum.id,
            freshTree,
            input.sessionId ?? null,
          )) ||
          !(await actorCanForumAction(
            tx,
            input.actorId,
            "start",
            forum.id,
            freshTree,
            input.sessionId ?? null,
          ))
        ) {
          reject("forbidden");
        }

        const blocked = await postingBlockedByWarning(tx, input.actorId);

        if (blocked !== null) {
          reject(blocked);
        }

        if (await isBlockedText(tx, title)) {
          reject("blocked_word");
        }

        const linkPolicy = await readLinkPolicy(tx, input.actorId);
        const links = countContentLinks(bodyMd);
        const images = countContentImages(bodyMd);
        const linkViolation =
          !linkPolicy.exempt &&
          ((linkPolicy.maxLinks > 0 && links > linkPolicy.maxLinks) ||
            (!linkPolicy.imagesAllowed && images > 0));

        if (linkViolation && linkPolicy.action === "reject") {
          reject("too_many_links");
        }

        let filterReason: string | null = linkViolation ? "link_limit" : null;
        let rendered: RenderResult;

        try {
          rendered = await savePostContent(tx, {
            bodyMd,
            authorId: input.actorId,
            forumId: forum.id,
            tree,
            sessionId: input.sessionId ?? null,
            options,
          });
        } catch (error) {
          if (
            error instanceof ContentError &&
            (error.code === "blocked_word" || error.code === "too_many_links")
          ) {
            reject(error.code);
          }

          throw error;
        }

        const spam = await evaluateSpam(tx, {
          authorId: input.actorId,
          bodyText: rendered.bodyText,
          bodyMd: rendered.bodyMd,
          hash: bodyHash(rendered.bodyText),
        });

        if (spam.rule !== null) {
          filterReason = spam.rule;
        }

        const approval = await decideApproval(tx, {
          actorId: input.actorId,
          forumId: forum.id,
          content: { kind: "topic", filterFlagged: filterReason !== null },
          tree: freshTree,
          sessionId: input.sessionId ?? null,
        });
        const hold = approval.hold || filterReason !== null;
        const holdReason = filterReason ?? approval.reason;
        const visibility = hold ? "unapproved" : "visible";
        const topicId = await insertTopic(tx, {
          forumId: forum.id,
          title,
          slug,
          prefixId,
          starterId: input.actorId,
          visibility,
          holdReason,
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
          mentionedMemberIds: rendered.mentionedMemberIds,
          quotedPostIds: rendered.quoteSources
            .filter((source) => source.kind === "post")
            .map((source) => source.id),
          visibility,
          holdReason,
        });

        await syncPostAttachments(tx, {
          postId: post.id,
          authorId: input.actorId,
          forumId: forum.id,
          sessionId: input.sessionId ?? null,
          bodyHtml: rendered.bodyHtml,
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
          visible: !hold,
        });

        await recordDuplicate(tx, input.actorId, bodyHash(rendered.bodyText));

        // Held content is not a public domain fact yet; approval emits `post.approved`.
        if (!hold) {
          await emit(tx, {
            type: "topic.created",
            aggregateId: BigInt(topicId),
            aggregateVersion: 1n,
            payloadIds: {
              topicId: BigInt(topicId),
              postId: BigInt(post.id),
              forumId: BigInt(forum.id),
              authorId: BigInt(input.actorId),
            },
          });
          await emit(tx, {
            type: "post.created",
            aggregateId: BigInt(post.id),
            aggregateVersion: 1n,
            payloadIds: {
              postId: BigInt(post.id),
              topicId: BigInt(topicId),
              forumId: BigInt(forum.id),
              authorId: BigInt(input.actorId),
            },
          });
        }
        // Starting a topic follows it when the member left auto-follow on (follows spec).
        if (input.autoFollow !== false) {
          await autoFollowTopic(tx, input.actorId, topicId);
        }

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

  const blockedBefore = await postingBlockedByWarning(sql, input.actorId);

  if (blockedBefore !== null) {
    return { ok: false, code: blockedBefore };
  }

  const topic = await loadTopicForWrite(sql, input.topicId);

  if (topic === null || topic.movedTo !== null) {
    return { ok: false, code: "topic_not_found" };
  }

  const tree = await loadForumTree(sql);

  if (
    !(await actorCanForumAction(
      sql,
      input.actorId,
      "read",
      topic.forumId,
      tree,
      input.sessionId ?? null,
    )) ||
    !(await actorCanForumAction(
      sql,
      input.actorId,
      "reply",
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
      mutation: postReplyMutation,
      input: { topicId: input.topicId, authorId: input.actorId },
      apply: async (tx) => {
        // The topic lock serialises position assignment and every counter update (ADR 0006).
        const current = await lockTopicForWrite(tx, input.topicId);

        if (current === null || current.movedTo !== null) {
          reject("topic_not_found");
        }

        const freshTree = await loadForumTree(tx);

        if (
          !(await actorCanForumAction(
            tx,
            input.actorId,
            "read",
            current.forumId,
            freshTree,
            input.sessionId ?? null,
          )) ||
          !(await actorCanForumAction(
            tx,
            input.actorId,
            "reply",
            current.forumId,
            freshTree,
            input.sessionId ?? null,
          ))
        ) {
          reject("forbidden");
        }

        const currentMayBypassLock = await actorCanModerate(
          tx,
          input.actorId,
          "lock",
          current.forumId,
          freshTree,
          input.sessionId ?? null,
        );

        if (current.locked && !currentMayBypassLock) {
          reject("locked");
        }

        const blocked = await postingBlockedByWarning(tx, input.actorId);

        if (blocked !== null) {
          reject(blocked);
        }

        const linkPolicy = await readLinkPolicy(tx, input.actorId);
        const links = countContentLinks(bodyMd);
        const images = countContentImages(bodyMd);
        const linkViolation =
          !linkPolicy.exempt &&
          ((linkPolicy.maxLinks > 0 && links > linkPolicy.maxLinks) ||
            (!linkPolicy.imagesAllowed && images > 0));

        if (linkViolation && linkPolicy.action === "reject") {
          reject("too_many_links");
        }

        let filterReason: string | null = linkViolation ? "link_limit" : null;
        let rendered: RenderResult;

        try {
          rendered = await savePostContent(tx, {
            bodyMd,
            authorId: input.actorId,
            forumId: current.forumId,
            tree,
            sessionId: input.sessionId ?? null,
            options,
          });
        } catch (error) {
          if (
            error instanceof ContentError &&
            (error.code === "blocked_word" || error.code === "too_many_links")
          ) {
            reject(error.code);
          }

          throw error;
        }

        const spam = await evaluateSpam(tx, {
          authorId: input.actorId,
          bodyText: rendered.bodyText,
          bodyMd: rendered.bodyMd,
          hash: bodyHash(rendered.bodyText),
        });

        if (spam.rule !== null) {
          filterReason = spam.rule;
        }

        const approval = await decideApproval(tx, {
          actorId: input.actorId,
          forumId: current.forumId,
          content: { kind: "post", filterFlagged: filterReason !== null },
          tree: freshTree,
          sessionId: input.sessionId ?? null,
        });
        const hold = approval.hold || filterReason !== null;
        const holdReason = filterReason ?? approval.reason;
        const post = await insertPost(tx, {
          topicId: current.id,
          authorId: input.actorId,
          bodyMd: rendered.bodyMd,
          bodyHtml: rendered.bodyHtml,
          bodyText: rendered.bodyText,
          renderVersion: rendered.renderVersion,
          sanitiserVersion: rendered.sanitiserVersion,
          quotedForumIds: rendered.quotedForumIds,
          mentionedMemberIds: rendered.mentionedMemberIds,
          quotedPostIds: rendered.quoteSources
            .filter((source) => source.kind === "post")
            .map((source) => source.id),
          visibility: hold ? "unapproved" : "visible",
          holdReason,
        });

        await syncPostAttachments(tx, {
          postId: post.id,
          authorId: input.actorId,
          forumId: current.forumId,
          sessionId: input.sessionId ?? null,
          bodyHtml: rendered.bodyHtml,
        });

        await recordDuplicate(tx, input.actorId, bodyHash(rendered.bodyText));

        await recordReply(tx, {
          topicId: current.id,
          forumId: current.forumId,
          postId: post.id,
          authorId: input.actorId,
          createdAt: post.createdAt,
          visible: !hold,
        });

        if (!hold) {
          await emit(tx, {
            type: "post.created",
            aggregateId: BigInt(post.id),
            aggregateVersion: 1n,
            payloadIds: {
              postId: BigInt(post.id),
              topicId: BigInt(current.id),
              forumId: BigInt(current.forumId),
              authorId: BigInt(input.actorId),
            },
          });
        }
        // Replying follows the topic unless the member turned auto-follow off.
        if (input.autoFollow !== false) {
          await autoFollowTopic(tx, input.actorId, current.id);
        }

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

  if (isAuthor && !canModerate) {
    const windowMinutes = await editWindowMinutes(sql, input.actorId);
    const ageMinutes = (Date.now() - post.createdAt.getTime()) / 60_000;

    if (windowMinutes > 0 && ageMinutes > windowMinutes) {
      return { ok: false, code: "edit_window_expired" };
    }
  } else if (!isAuthor && !canModerate) {
    return { ok: false, code: "forbidden" };
  }

  const mayRedact = (input.redact ?? !isAuthor) && canModerate && !isAuthor;

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

        const freshTree = await loadForumTree(tx);
        const currentIsAuthor = current.authorId !== null && current.authorId === input.actorId;
        const currentCanModerate = await actorCanModerate(
          tx,
          input.actorId,
          "edit",
          current.forumId,
          freshTree,
          input.sessionId ?? null,
        );

        if (
          !(await actorCanForumAction(
            tx,
            input.actorId,
            "read",
            current.forumId,
            freshTree,
            input.sessionId ?? null,
          ))
        ) {
          reject("forbidden");
        }

        if (!currentIsAuthor && !currentCanModerate) {
          reject("forbidden");
        }

        if (currentIsAuthor && !currentCanModerate) {
          const currentWindow = await editWindowMinutes(tx, input.actorId);
          const currentAge = (Date.now() - current.createdAt.getTime()) / 60_000;

          if (currentWindow > 0 && currentAge > currentWindow) {
            reject("edit_window_expired");
          }
        }

        await insertPostRevision(tx, current);

        let rendered: RenderResult;

        try {
          rendered = await savePostContent(tx, {
            bodyMd,
            authorId: input.actorId,
            forumId: current.forumId,
            tree,
            sessionId: input.sessionId ?? null,
            options,
          });
        } catch (error) {
          if (
            error instanceof ContentError &&
            (error.code === "blocked_word" || error.code === "too_many_links")
          ) {
            reject(error.code);
          }

          throw error;
        }

        await updatePostRendering(tx, {
          postId: current.id,
          bodyMd: rendered.bodyMd,
          bodyHtml: rendered.bodyHtml,
          bodyText: rendered.bodyText,
          renderVersion: rendered.renderVersion,
          sanitiserVersion: rendered.sanitiserVersion,
          quotedForumIds: rendered.quotedForumIds,
          mentionedMemberIds: rendered.mentionedMemberIds,
          quotedPostIds: rendered.quoteSources
            .filter((source) => source.kind === "post")
            .map((source) => source.id),
          editedBy: input.actorId,
        });

        await syncPostAttachments(tx, {
          postId: current.id,
          authorId: input.actorId,
          forumId: current.forumId,
          sessionId: input.sessionId ?? null,
          bodyHtml: rendered.bodyHtml,
        });

        const currentRedact =
          (input.redact ?? !currentIsAuthor) && currentCanModerate && !currentIsAuthor;

        if (currentRedact) {
          await protectPostRevisions(tx, current.id);
          await redactQuoteSnapshotsInTransaction(tx, { kind: "post", id: current.id });
        }

        return {
          topicId: current.topicId,
          postId: current.id,
          redacted: currentRedact,
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
