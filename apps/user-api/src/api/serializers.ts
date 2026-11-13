import type { ForumRecord } from "@bulletin/domain/forums";
import type { ProfileRecord } from "@bulletin/domain/profiles";
import type { SearchHit } from "@bulletin/domain/search";
import type { TopicListRow, TopicPostRow, TopicRecord } from "@bulletin/domain/topics";
import { canonicalUrl } from "@bulletin/domain/urls";

/** JSON-safe shapes for `/api/v1`: IDs and public URLs, never internal security fields. */
export function forumJson(forum: ForumRecord): Readonly<Record<string, unknown>> {
  return {
    id: forum.id,
    parentId: forum.parentId,
    type: forum.type,
    title: forum.title,
    slug: forum.slug,
    url: canonicalUrl("forum", forum.id, forum.slug),
    description: forum.description,
    passwordProtected: forum.passwordProtected,
    redirectUrl: forum.redirectUrl,
    topicCount: forum.topicCount,
    postCount: forum.postCount,
    lastPostId: forum.lastPostId,
    lastPostAt: forum.lastPostAt,
    lastPostMemberName: forum.lastPostMemberName,
  };
}

export function topicJson(topic: TopicRecord): Readonly<Record<string, unknown>> {
  return {
    id: topic.id,
    forumId: topic.forumId,
    title: topic.title,
    slug: topic.slug,
    url: canonicalUrl("topic", topic.id, topic.slug),
    prefixId: topic.prefixId,
    starterId: topic.starterId,
    pinned: topic.pinned,
    locked: topic.locked,
    replyCount: topic.replyCount,
    viewCount: Number(topic.viewCount),
    createdAt: topic.createdAt,
    lastPostId: topic.lastPostId,
    lastPostAt: topic.lastPostAt,
    movedTo: topic.movedTo,
  };
}

export function topicListJson(row: TopicListRow): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    url: canonicalUrl("topic", row.id, row.slug),
    prefixId: row.prefixId,
    prefix: row.prefixLabel,
    prefixColour: row.prefixColour,
    starterId: row.starterId,
    starterName: row.starterName,
    pinned: row.pinned,
    locked: row.locked,
    movedTo: row.movedTo,
    replyCount: row.replyCount,
    viewCount: Number(row.viewCount),
    lastPostId: row.lastPostId,
    lastPostAt: row.lastPostAt,
    lastPostMemberName: row.lastPostMemberName,
  };
}

export function postJson(row: TopicPostRow, topic: TopicRecord): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    topicId: topic.id,
    url: `${canonicalUrl("topic", topic.id, topic.slug, { postId: row.id })}`,
    author: { id: row.authorId, name: row.authorName },
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    position: row.position,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    editedByName: row.editedByName,
  };
}

export function memberJson(member: ProfileRecord): Readonly<Record<string, unknown>> {
  return {
    id: member.id,
    displayName: member.displayName,
    url: canonicalUrl("profile", member.id, member.displayName ?? ""),
    avatarHash: member.avatarHash,
    joinedAt: member.joinedAt,
    lastActiveAt: member.hideOnline ? null : member.lastActiveAt,
    postCount: member.postCount,
    reputation: member.reputation,
    customTitle: member.customTitle,
    groupTitle: member.groupTitle,
    groupColour: member.groupColour,
    rank: {
      title: member.rankTitleLabels,
      pips: member.rankPips,
      imageKey: member.rankImageKey,
    },
  };
}

export function searchHitJson(hit: SearchHit): Readonly<Record<string, unknown>> {
  if (hit.kind === "topic") {
    return {
      kind: hit.kind,
      id: hit.topicId,
      title: hit.topicTitle,
      url: canonicalUrl("topic", hit.topicId, hit.topicSlug),
      forumId: hit.forumId,
      forumTitle: hit.forumTitle,
      authorId: hit.authorId,
      authorName: hit.authorDisplayName,
      createdAt: hit.createdAt,
      snippet: hit.snippet,
    };
  }

  return {
    kind: hit.kind,
    id: hit.postId,
    topicId: hit.topicId,
    title: hit.topicTitle,
    url: canonicalUrl("topic", hit.topicId, hit.topicSlug, { postId: hit.postId }),
    forumId: hit.forumId,
    forumTitle: hit.forumTitle,
    authorId: hit.authorId,
    authorName: hit.authorDisplayName,
    createdAt: hit.createdAt,
    position: hit.position,
    snippet: hit.snippet,
  };
}
