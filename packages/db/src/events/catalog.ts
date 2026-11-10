/** The typed event catalog. Payloads carry IDs only, never content or personal data. */
export const EVENT_CATALOG = {
  "post.created": {
    aggregateType: "post",
    payloadIds: ["postId", "topicId", "forumId", "authorId"],
  },
  "member.promoted": {
    aggregateType: "member",
    payloadIds: ["memberId", "fromGroupId", "toGroupId", "ruleId"],
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
