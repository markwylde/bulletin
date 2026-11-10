import {
  forumTag,
  GLOBAL_CACHE_TAGS,
  memberTag,
  postSnapshotsTag,
  postTag,
  topicPagesTag,
  topicTag,
} from "@bulletin/cache";
import type { Mutation } from "./index.ts";

/**
 * What a topic/post write invalidated. Every write reports the topic and forum chain it
 * touched; counter changes also report the members whose post count moved (ADR 0006).
 */
export interface TopicContentSummary {
  readonly topicId: string;
  /** The topic's forum and every ancestor whose lists or counters changed. */
  readonly forumIds: readonly string[];
  /** Authors whose post count and therefore author card changed. */
  readonly memberIds: readonly string[];
}

export interface PostEditSummary {
  readonly topicId: string;
  readonly postId: string;
  /** True when earlier versions were redacted, which rebuilds every quoting fragment. */
  readonly redacted: boolean;
}

/** What a successful new topic/reply returns, alongside the tags it invalidated. */
export interface TopicWriteResult extends TopicContentSummary {
  readonly postId: string;
  readonly position: number;
}

export interface TopicStartInput {
  readonly forumId: string;
  readonly authorId: string;
}

export interface PostReplyInput {
  readonly topicId: string;
  readonly authorId: string;
}

function uniqueTags(tags: readonly string[]): readonly string[] {
  return [...new Set(tags)];
}

/** A new or deleted topic/post changes the topic, its pages, the forum chain and authors. */
function contentTags(summary: TopicContentSummary): readonly string[] {
  return uniqueTags([
    topicTag(summary.topicId),
    topicPagesTag(summary.topicId),
    ...summary.forumIds.map(forumTag),
    GLOBAL_CACHE_TAGS.board,
    ...summary.memberIds.map(memberTag),
  ]);
}

export const topicStartMutation: Mutation<TopicStartInput, TopicWriteResult> = {
  name: "topic.start",
  tags: (_input, result) => contentTags(result),
};

export const postReplyMutation: Mutation<PostReplyInput, TopicWriteResult> = {
  name: "post.reply",
  tags: (_input, result) => contentTags(result),
};

/**
 * An edit rebuilds the topic page (the post block is part of it) but not the forum's
 * last-post preview or the author card. A redaction also rebuilds every quote of the post.
 */
export const postEditMutation: Mutation<PostEditSummary, PostEditSummary> = {
  name: "post.edit",
  tags: (_input, result) =>
    uniqueTags([
      topicTag(result.topicId),
      topicPagesTag(result.topicId),
      postTag(result.postId),
      ...(result.redacted ? [postSnapshotsTag(result.postId)] : []),
    ]),
};

export const postDeleteMutation: Mutation<{ readonly postId: string }, TopicContentSummary> = {
  name: "post.delete",
  tags: (input, result) => uniqueTags([postTag(input.postId), ...contentTags(result)]),
};

export const postRestoreMutation: Mutation<{ readonly postId: string }, TopicContentSummary> = {
  name: "post.restore",
  tags: (input, result) => uniqueTags([postTag(input.postId), ...contentTags(result)]),
};

export const topicHardDeleteMutation: Mutation<{ readonly topicId: string }, TopicContentSummary> =
  {
    name: "topic.hard_delete",
    tags: (_input, result) => contentTags(result),
  };

export const postHardDeleteMutation: Mutation<{ readonly postId: string }, TopicContentSummary> = {
  name: "post.hard_delete",
  tags: (_input, result) => contentTags(result),
};

export const topicLockMutation: Mutation<
  { readonly topicId: string; readonly locked: boolean },
  TopicContentSummary
> = {
  name: "topic.lock",
  tags: (_input, result) => contentTags(result),
};

export const topicPinMutation: Mutation<
  { readonly topicId: string; readonly pinned: boolean },
  TopicContentSummary
> = {
  name: "topic.pin",
  tags: (_input, result) => contentTags(result),
};

/** A move touches both forum chains, the topic page and the board index. */
export const topicMoveMutation: Mutation<
  { readonly topicId: string; readonly toForumId: string },
  TopicContentSummary
> = {
  name: "topic.move",
  tags: (_input, result) => contentTags(result),
};
