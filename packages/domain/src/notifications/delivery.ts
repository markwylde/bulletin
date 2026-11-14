import type { SQL } from "bun";

export type NotificationDeliveryChannel = "email" | "push";

/**
 * Records one notification delivery intent in the deciding transaction (ADR 0012). It is
 * idempotent per source event, so a retried job does not duplicate the delivery while a later
 * event can still deliver the same coalesced notification. Returns null once this event's
 * intent was delivered.
 */
async function createNotificationIntent(
  sql: SQL,
  memberId: string,
  notificationId: bigint,
  sourceEventId: bigint,
  channel: NotificationDeliveryChannel,
): Promise<bigint | null> {
  const inserted = (await sql`
    INSERT INTO core.delivery_intents (member_id, kind, ref_id, channel, source_event_id)
    VALUES (${memberId}, 'notification', ${notificationId}, ${channel}, ${sourceEventId})
    ON CONFLICT (kind, ref_id, channel, (coalesce(source_event_id, 0))) DO NOTHING
    RETURNING id
  `) as Array<{ id: bigint | string }>;
  const created = inserted[0];

  if (created !== undefined) {
    return BigInt(created.id);
  }

  const [existing] = (await sql`
    SELECT id
    FROM core.delivery_intents
    WHERE kind = 'notification'
      AND ref_id = ${notificationId}
      AND channel = ${channel}
      AND source_event_id = ${sourceEventId}
      AND delivered_at IS NULL
  `) as Array<{ id: bigint | string }>;

  return existing === undefined ? null : BigInt(existing.id);
}

export async function createNotificationEmailIntent(
  sql: SQL,
  memberId: string,
  notificationId: bigint,
  sourceEventId: bigint,
): Promise<bigint | null> {
  return createNotificationIntent(sql, memberId, notificationId, sourceEventId, "email");
}

export async function createNotificationPushIntent(
  sql: SQL,
  memberId: string,
  notificationId: bigint,
  sourceEventId: bigint,
): Promise<bigint | null> {
  return createNotificationIntent(sql, memberId, notificationId, sourceEventId, "push");
}
