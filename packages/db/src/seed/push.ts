import { emit } from "@bulletin/domain/events";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

const PUSH_ENDPOINT_ENV = "BULLETIN_SEED_PUSH_ENDPOINT";

/**
 * The fixed test subscription key from `mocks/push`. The mock owns the matching private key,
 * so its inspector can decrypt and show the payload a real push service would only relay.
 */
export const SEED_PUSH_KEYS = {
  p256dh: "BIoMX_sxHUuVgqtbRjUPQBmOJgqJL1azm_DDUuGNia78sRv4-2LFBClJjN0H-3zsedfsUGONe8p4E52YdSNf3Og",
  auth: "QzIEZZnroZ1M_sdeIc8vqA",
} as const;

async function memberId(sql: SQL, sub: string): Promise<string> {
  const [row] = (await sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing seed member ${sub}`);
  }

  return row.member_id;
}

interface PushConversation {
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly version: number;
}

async function seededConversation(sql: SQL): Promise<PushConversation> {
  const [row] = (await sql`
    SELECT
      c.id::text AS conversation_id,
      last_message.id::text AS message_id,
      last_message.author_id::text AS sender_id,
      (SELECT count(*)::int FROM core.conversation_messages m WHERE m.conversation_id = c.id)
        AS version
    FROM core.conversations c
    JOIN LATERAL (
      SELECT id, author_id
      FROM core.conversation_messages
      WHERE conversation_id = c.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) AS last_message ON true
    WHERE c.title = 'Weekend plans'
    LIMIT 1
  `) as Array<{
    conversation_id: string;
    message_id: string;
    sender_id: string;
    version: number;
  }>;

  if (row === undefined) {
    throw new Error("Missing the seeded Weekend plans conversation");
  }

  return {
    conversationId: row.conversation_id,
    messageId: row.message_id,
    senderId: row.sender_id,
    version: row.version,
  };
}

/**
 * A development push subscription and one real `pm.sent` outbox event (task 4.2). The worker
 * processes the event after the seed transaction commits, creates the notification and push
 * intent, and sends the encrypted payload to the push mock for inspection.
 */
export const pushSeedModule: SeedModule = {
  name: "push",
  dependsOn: ["members", "conversations", "notifications"],
  async run({ sql }) {
    const endpoint = Bun.env[PUSH_ENDPOINT_ENV]?.trim() ?? "";

    if (endpoint === "") {
      return;
    }

    const recipient = await memberId(sql, "member-1");
    const conversation = await seededConversation(sql);

    await sql`
      INSERT INTO pii.push_subscriptions (
        member_id, endpoint, p256dh, auth_secret, label, browser_family
      ) VALUES (
        ${recipient}, ${endpoint}, ${SEED_PUSH_KEYS.p256dh}, ${SEED_PUSH_KEYS.auth},
        'Seed phone', 'chrome'
      )
      ON CONFLICT (endpoint) DO UPDATE
        SET member_id = EXCLUDED.member_id,
            p256dh = EXCLUDED.p256dh,
            auth_secret = EXCLUDED.auth_secret,
            label = EXCLUDED.label,
            browser_family = EXCLUDED.browser_family,
            updated_at = now()
    `;

    await sql`
      INSERT INTO core.notification_preferences (member_id, type, channel, enabled)
      VALUES (${recipient}, 'conversation.message', 'push', true)
      ON CONFLICT (member_id, type, channel) DO UPDATE SET enabled = EXCLUDED.enabled
    `;

    await emit(sql, {
      type: "pm.sent",
      aggregateId: BigInt(conversation.conversationId),
      aggregateVersion: BigInt(conversation.version),
      payloadIds: {
        conversationId: BigInt(conversation.conversationId),
        messageId: BigInt(conversation.messageId),
        senderId: BigInt(conversation.senderId),
      },
    });
  },
};
