import type { NotificationType } from "../notifications/repository.ts";

/** Generic, localised titles the device shows when it cannot fetch details. */
export const PUSH_TITLE_KEYS = {
  "topic.reply": { titleKey: "push.title.topicReply" },
  "topic.created": { titleKey: "push.title.topicCreated" },
  "post.mention": { titleKey: "push.title.postMention" },
  "post.quote": { titleKey: "push.title.postQuote" },
  "member.promoted": { titleKey: "push.title.memberPromoted" },
  "reaction.added": { titleKey: "push.title.reaction" },
  "reputation.given": { titleKey: "push.title.reputation" },
  "friend.accepted": { titleKey: "push.title.friendAccepted" },
  "badge.awarded": { titleKey: "push.title.badgeAwarded" },
  "conversation.message": { titleKey: "push.title.conversation" },
  "post.approved": { titleKey: "push.title.postApproved" },
  "report.resolved": { titleKey: "push.title.reportResolved" },
  "report.rejected": { titleKey: "push.title.reportRejected" },
  "warning.issued": { titleKey: "push.title.warning" },
  "webhook.disabled": { titleKey: "push.title.webhookDisabled" },
} as const satisfies Record<NotificationType, { readonly titleKey: string }>;

/** Fallback when a payload has no usable title key or the preview cannot be fetched. */
export const PUSH_GENERIC_TITLE_KEY = { titleKey: "push.title.generic" } as const;

export function pushTitleKey(type: NotificationType): string {
  return PUSH_TITLE_KEYS[type].titleKey;
}

/**
 * The content-free push payload (ADR 0014): a notification reference and a generic title key.
 * Topic titles, post text, actor names and URLs are fetched by the device after it authenticates.
 */
export interface PushPayload {
  readonly n: string;
  readonly t: string;
}

export function pushPayload(notificationId: string, type: NotificationType): PushPayload {
  return { n: notificationId, t: pushTitleKey(type) };
}
