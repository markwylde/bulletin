/**
 * The event types an external webhook can subscribe to. Private-message and member events
 * stay out of the public webhook catalogue; these are content events with a public URL.
 */
export const WEBHOOK_EVENTS = [
  "topic.created",
  "post.created",
  "post.edited",
  "post.deleted",
  "post.restored",
  "post.approved",
  "reaction.added",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

const EVENT_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);

export function isWebhookEvent(value: string): value is WebhookEventType {
  return EVENT_SET.has(value);
}

/** Unknown values are dropped, so a tampered row cannot subscribe to a private event. */
export function canonicalWebhookEvents(values: readonly string[]): readonly WebhookEventType[] {
  const allowed = new Set(values.filter(isWebhookEvent));
  return WEBHOOK_EVENTS.filter((event) => allowed.has(event));
}

/** Content fields a webhook may opt into; default payloads carry only IDs and public URLs. */
export const WEBHOOK_CONTENT_FIELDS = ["title", "bodyMd", "bodyHtml", "bodyText"] as const;

export type WebhookContentField = (typeof WEBHOOK_CONTENT_FIELDS)[number];

const CONTENT_SET: ReadonlySet<string> = new Set(WEBHOOK_CONTENT_FIELDS);

export function isWebhookContentField(value: string): value is WebhookContentField {
  return CONTENT_SET.has(value);
}

export function canonicalWebhookContentFields(
  values: readonly string[],
): readonly WebhookContentField[] {
  const allowed = new Set(values.filter(isWebhookContentField));
  return WEBHOOK_CONTENT_FIELDS.filter((field) => allowed.has(field));
}
