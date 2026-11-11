import type { SQL } from "bun";

/**
 * Records one notification email intent in the deciding transaction (ADR 0012). Idempotent per
 * `(kind, ref, channel)`: a retried event finds the existing undelivered intent instead of
 * creating another. Returns null once it was delivered.
 */
export async function createNotificationEmailIntent(
  sql: SQL,
  memberId: string,
  notificationId: bigint,
): Promise<bigint | null> {
  const inserted = (await sql`
    INSERT INTO core.delivery_intents (member_id, kind, ref_id, channel)
    VALUES (${memberId}, 'notification', ${notificationId}, 'email')
    ON CONFLICT (kind, ref_id, channel) DO NOTHING
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
      AND channel = 'email'
      AND delivered_at IS NULL
  `) as Array<{ id: bigint | string }>;

  return existing === undefined ? null : BigInt(existing.id);
}
