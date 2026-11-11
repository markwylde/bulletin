import type { SQL } from "bun";

export const DIGEST_FREQUENCIES = ["off", "daily", "weekly"] as const;

export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export function isDigestFrequency(value: string): value is DigestFrequency {
  return (DIGEST_FREQUENCIES as readonly string[]).includes(value);
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export function digestWindowMs(frequency: "daily" | "weekly"): number {
  return frequency === "daily" ? DAY_MS : 7 * DAY_MS;
}

export async function digestFrequency(sql: SQL, memberId: string): Promise<DigestFrequency> {
  const [row] = (await sql`
    SELECT frequency FROM core.digest_subscriptions WHERE member_id = ${memberId}
  `) as Array<{ frequency: string }>;

  return row !== undefined && isDigestFrequency(row.frequency) ? row.frequency : "off";
}

export async function setDigestFrequency(
  sql: SQL,
  memberId: string,
  frequency: DigestFrequency,
): Promise<void> {
  await sql`
    INSERT INTO core.digest_subscriptions (member_id, frequency)
    VALUES (${memberId}, ${frequency})
    ON CONFLICT (member_id) DO UPDATE
      SET frequency = EXCLUDED.frequency, updated_at = now()
  `;
}

export interface QueuedDigest {
  readonly memberId: string;
  readonly deliveryId: string;
  readonly intentId: string;
}

/**
 * Queues one digest per subscribed member for the given cadence. The delivery row fixes the
 * period, the intent records the send, and `last_sent_at` moves so the next run starts after it.
 * The caller enqueues the per-member email jobs after each transaction.
 */
export async function queueDigests(
  sql: SQL,
  frequency: "daily" | "weekly",
  options: {
    readonly now?: Date;
    /** False when the `digests` flag is off for the member. */
    readonly isEnabled?: (memberId: string) => Promise<boolean>;
  } = {},
): Promise<readonly QueuedDigest[]> {
  const now = options.now ?? new Date();
  const window = digestWindowMs(frequency);
  const rows = (await sql`
    SELECT s.member_id::text AS member_id, s.last_sent_at
    FROM core.digest_subscriptions s
    JOIN core.members m ON m.id = s.member_id AND m.state = 'active'
    WHERE s.frequency = ${frequency}
      AND NOT EXISTS (
        SELECT 1
        FROM core.digest_deliveries d
        JOIN core.delivery_intents i
          ON i.kind = 'digest' AND i.ref_id = d.id AND i.channel = 'email' AND i.delivered_at IS NULL
        WHERE d.member_id = s.member_id AND d.frequency = s.frequency
      )
  `) as Array<{ member_id: string; last_sent_at: Date | string | null }>;
  const queued: QueuedDigest[] = [];

  for (const row of rows) {
    if (options.isEnabled !== undefined && !(await options.isEnabled(row.member_id))) {
      continue;
    }

    const periodStart =
      row.last_sent_at === null ? new Date(now.getTime() - window) : new Date(row.last_sent_at);

    const ids = await sql.begin(
      async (tx): Promise<{ deliveryId: string; intentId: string } | null> => {
        const [delivery] = (await tx`
          INSERT INTO core.digest_deliveries (member_id, frequency, period_start, period_end)
          VALUES (${row.member_id}, ${frequency}, ${periodStart}, ${now})
          ON CONFLICT (member_id, frequency, period_end) DO NOTHING
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (delivery === undefined) {
          return null;
        }

        const [intent] = (await tx`
          INSERT INTO core.delivery_intents (member_id, kind, ref_id, channel)
          VALUES (${row.member_id}, 'digest', ${delivery.id}, 'email')
          ON CONFLICT DO NOTHING
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        return intent === undefined ? null : { deliveryId: delivery.id, intentId: intent.id };
      },
    );

    if (ids !== null) {
      queued.push({ memberId: row.member_id, ...ids });
    }
  }

  return queued;
}

export interface PendingDigestDelivery {
  readonly memberId: string;
  readonly deliveryId: string;
  readonly intentId: string;
}

/**
 * Digest deliveries whose intent was committed but whose email job may never have been
 * enqueued (a crash or queue failure between commit and enqueue). The cron re-enqueues these
 * with the delivery's original window; `delivery_target` refuses an already delivered intent.
 */
export async function pendingDigestDeliveries(
  sql: SQL,
  limit = 1_000,
): Promise<readonly PendingDigestDelivery[]> {
  const rows = (await sql`
    SELECT
      d.id::text AS delivery_id,
      d.member_id::text AS member_id,
      i.id::text AS intent_id
    FROM core.digest_deliveries d
    JOIN core.delivery_intents i
      ON i.kind = 'digest' AND i.ref_id = d.id AND i.channel = 'email'
    WHERE i.delivered_at IS NULL
    ORDER BY d.id
    LIMIT ${limit}
  `) as Array<{ delivery_id: string; member_id: string; intent_id: string }>;

  return rows.map((row) => ({
    memberId: row.member_id,
    deliveryId: row.delivery_id,
    intentId: row.intent_id,
  }));
}
