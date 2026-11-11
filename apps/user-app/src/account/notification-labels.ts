import type { NotificationType } from "@bulletin/domain/notifications";

/** i18n keys for each notification type, shared by preferences and unsubscribe pages. */
export const NOTIFICATION_TYPE_LABELS = {
  "topic.reply": { labelKey: "notification.type.topic.reply" },
  "topic.created": { labelKey: "notification.type.topic.created" },
  "post.mention": { labelKey: "notification.type.post.mention" },
  "post.quote": { labelKey: "notification.type.post.quote" },
  "member.promoted": { labelKey: "notification.type.member.promoted" },
  "reaction.added": { labelKey: "notification.type.reaction.added" },
  "reputation.given": { labelKey: "notification.type.reputation.given" },
  "friend.accepted": { labelKey: "notification.type.friend.accepted" },
} satisfies Record<NotificationType, { labelKey: string }>;
