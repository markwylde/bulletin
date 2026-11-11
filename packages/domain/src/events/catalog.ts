/**
 * The typed event catalog. Payloads carry IDs only, never content or personal data
 * (ADR 0011). Types are added by the change that first emits them; the notification, follow
 * and digest features consume `topic.created`, `post.created` and `member.promoted` today.
 */
export const EVENT_CATALOG = {
  "topic.created": {
    aggregateType: "topic",
    payloadIds: ["topicId", "postId", "forumId", "authorId"],
  },
  "post.created": {
    aggregateType: "post",
    payloadIds: ["postId", "topicId", "forumId", "authorId"],
  },
  "post.edited": {
    aggregateType: "post",
    payloadIds: ["postId", "topicId", "forumId", "authorId", "editorId"],
  },
  "post.deleted": {
    aggregateType: "post",
    payloadIds: ["postId", "topicId", "forumId", "authorId", "actorId"],
  },
  "post.restored": {
    aggregateType: "post",
    payloadIds: ["postId", "topicId", "forumId", "authorId", "actorId"],
  },
  "post.approved": {
    aggregateType: "post",
    payloadIds: ["postId", "topicId", "forumId", "authorId", "actorId"],
  },
  "member.created": {
    aggregateType: "member",
    payloadIds: ["memberId"],
  },
  "member.promoted": {
    aggregateType: "member",
    payloadIds: ["memberId", "fromGroupId", "toGroupId", "ruleId"],
  },
  "pm.sent": {
    aggregateType: "conversation",
    payloadIds: ["conversationId", "messageId", "senderId"],
  },
  "reaction.added": {
    aggregateType: "post",
    payloadIds: ["reactionId", "postId", "topicId", "memberId"],
  },
  "report.created": {
    aggregateType: "report",
    payloadIds: ["reportId", "reporterId", "targetMemberId"],
  },
  "warning.issued": {
    aggregateType: "warning",
    payloadIds: ["warningId", "memberId", "actorId"],
  },
  "badge.awarded": {
    aggregateType: "member",
    payloadIds: ["memberId", "badgeId"],
  },
  "notification.created": {
    aggregateType: "notification",
    payloadIds: ["notificationId", "memberId"],
  },
  "follow.created": {
    aggregateType: "follow",
    payloadIds: ["memberId", "targetId"],
  },
  "follow.removed": {
    aggregateType: "follow",
    payloadIds: ["memberId", "targetId"],
  },
  "digest.sent": {
    aggregateType: "member",
    payloadIds: ["memberId"],
  },
  // A forum's visibility may have changed for some group; workers purge its CDN subtree.
  "forum.visibility.changed": {
    aggregateType: "forum",
    payloadIds: ["forumId"],
  },
} as const;

export type EventType = keyof typeof EVENT_CATALOG;

type PayloadIdName<T extends EventType> = (typeof EVENT_CATALOG)[T]["payloadIds"][number];

export type EventPayloadIds<T extends EventType> = {
  readonly [K in PayloadIdName<T>]: bigint;
};

export interface DomainEvent<T extends EventType> {
  readonly type: T;
  readonly aggregateId: bigint;
  readonly aggregateVersion: bigint;
  readonly payloadIds: EventPayloadIds<T>;
}
