import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { startConversation } from "@bulletin/domain/conversations";
import { loadEvent } from "@bulletin/domain/events";
import { createSafeFetch } from "@bulletin/domain/net";
import {
  createNotification,
  createNotificationPushIntent,
  type NotificationRecipient,
  notificationPreview,
  setNotificationPreference,
} from "@bulletin/domain/notifications";
import { loadVapidConfig, pushPayload } from "@bulletin/domain/push";
import { reply, startTopic } from "@bulletin/domain/topics";
import { createPushHandler, createPushStore } from "@bulletin/mock-push/server";
import { PUSH_TEST_KEYS } from "@bulletin/mock-push/test-keys";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import { processNotificationRecipients } from "../../apps/workers/src/notifications.ts";
import { deliverNotificationPush } from "../../apps/workers/src/push.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function roleUrl(database: TestDatabase, role: string): string {
  const url = new URL(database.url);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function withRole(
  database: TestDatabase,
  role: string,
  run: (sql: SQL) => Promise<void>,
): Promise<void> {
  const sql = new SQL(roleUrl(database, role));

  try {
    await run(sql);
  } finally {
    await sql.close();
  }
}

interface PushStack {
  readonly database: TestDatabase;
  readonly store: ReturnType<typeof createPushStore>;
  readonly base: string;
}

async function withPushStack(run: (stack: PushStack) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const store = createPushStore();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createPushHandler(store) });
  const port = server.port;

  try {
    await withTestDatabase({ adminUrl, prefix: "push_delivery" }, async (database) => {
      await runSeeds({
        sql: database.sql,
        registry: new SeedRegistry([
          baseSeedModule,
          flagsSeedModule,
          permissionFixtureSeedModule,
          groupsSeedModule,
          forumExtrasSeedModule,
          membersSeedModule,
        ]),
      });

      await run({ database, store, base: `http://127.0.0.1:${port}` });
    });
  } finally {
    server.stop(true);
  }
}

async function memberId(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return row.member_id;
}

async function sessionToken(database: TestDatabase, memberIdValue: string, token: string) {
  await withRole(database, "user_api", async (sql) => {
    await sql`
      INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
      VALUES (
        ${memberIdValue}, 'user', sha256(convert_to(${token}, 'UTF8')), now() + interval '24 hours'
      )
    `;
  });
}

async function saveDevice(
  database: TestDatabase,
  token: string,
  endpoint: string,
): Promise<string> {
  let deviceId = "";

  await withRole(database, "user_api", async (sql) => {
    const [row] = (await sql`
      SELECT pii.save_push_subscription(
        ${token}, ${endpoint}, ${PUSH_TEST_KEYS.publicKey}, ${PUSH_TEST_KEYS.auth},
        'Test device', 'Chrome/120.0 Safari/537'
      ) AS device_id
    `) as Array<{ device_id: string | null }>;
    deviceId = row?.device_id ?? "";
  });

  return deviceId;
}

function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): T {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

interface Fixture {
  readonly topicId: string;
  readonly forumId: string;
  readonly postId: string;
  readonly starter: string;
  readonly actor: string;
  readonly eventId: bigint;
}

async function replyFixture(database: TestDatabase): Promise<Fixture> {
  const [forum] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = 'off-topic'
  `) as Array<{ id: string }>;
  const starter = await memberId(database, "member-2");
  const actor = await memberId(database, "member-1");
  const topic = expectOk(
    await startTopic(database.sql, {
      actorId: starter,
      forumId: forum?.id ?? "0",
      title: "Push topic with a very secret title",
      bodyMd: "A secret opening post.",
    }),
  );
  const post = expectOk(
    await reply(database.sql, {
      actorId: actor,
      topicId: topic.topicId,
      bodyMd: "A secret reply body that must never be pushed.",
    }),
  );
  const [event] = (await database.sql`
    SELECT id FROM core.events WHERE type = 'post.created' ORDER BY id DESC LIMIT 1
  `) as Array<{ id: bigint | string }>;

  return {
    topicId: topic.topicId,
    forumId: forum?.id ?? "0",
    postId: post.postId,
    starter,
    actor,
    eventId: BigInt(event?.id ?? 0),
  };
}

async function topicNotification(
  database: TestDatabase,
  fixture: Fixture,
): Promise<{ readonly notificationId: bigint; readonly intentId: bigint }> {
  await setNotificationPreference(database.sql, fixture.starter, "topic.reply", "push", true);
  const notificationId = await createNotification(database.sql, {
    memberId: fixture.starter,
    type: "topic.reply",
    eventId: fixture.eventId,
    actorId: fixture.actor,
    topicId: fixture.topicId,
    forumId: fixture.forumId,
    postId: fixture.postId,
  });

  if (notificationId === null) {
    throw new Error("Notification was deduplicated");
  }

  const intentId = await createNotificationPushIntent(
    database.sql,
    fixture.starter,
    notificationId,
    fixture.eventId,
  );

  if (intentId === null) {
    throw new Error("No push intent");
  }

  return { notificationId, intentId };
}

function deliveryOptions() {
  return {
    vapid: loadVapidConfig({}, "development"),
    fetch: createSafeFetch({ devAllow: ["127.0.0.1"] }),
  };
}

integrationDescribe("push delivery", () => {
  test("sends a content-free VAPID push to the mock and records usage", async () => {
    await withPushStack(async ({ database, store, base }) => {
      const fixture = await replyFixture(database);
      const recipient = fixture.starter;
      await sessionToken(database, recipient, "push-success-session");
      await saveDevice(database, "push-success-session", `${base}/push/success`);
      const { notificationId, intentId } = await topicNotification(database, fixture);

      const result = await deliverNotificationPush(
        database.sql,
        deliveryOptions(),
        intentId.toString(),
      );

      expect(result.sent).toBe(1);
      expect(result.removed).toBe(0);
      expect(store.list()).toHaveLength(1);
      const message = store.list()[0];
      expect(message?.body).toEqual(pushPayload(notificationId.toString(), "topic.reply"));
      expect(message?.body).toEqual({ n: notificationId.toString(), t: "push.title.topicReply" });
      expect(JSON.stringify(message?.body)).not.toContain("very secret title");
      expect(JSON.stringify(message?.body)).not.toContain("secret reply body");
      expect(message?.headers["content-encoding"]).toBe("aes128gcm");
      expect(message?.headers.authorization?.startsWith("vapid t=")).toBe(true);

      const [intent] = (await database.sql`
        SELECT delivered_at FROM core.delivery_intents WHERE id = ${intentId}
      `) as Array<{ delivered_at: Date | string | null }>;
      expect(intent?.delivered_at).not.toBeNull();

      const [device] = (await database.sql`
        SELECT last_used_at FROM pii.push_subscriptions
        WHERE member_id = ${recipient} AND endpoint = ${`${base}/push/success`}
      `) as Array<{ last_used_at: Date | string | null }>;
      expect(device?.last_used_at).not.toBeNull();
    });
  }, 60_000);

  test("removes a subscription the push service reports as gone", async () => {
    await withPushStack(async ({ database, store, base }) => {
      const fixture = await replyFixture(database);
      const recipient = fixture.starter;
      await sessionToken(database, recipient, "push-gone-session");
      await saveDevice(database, "push-gone-session", `${base}/push/gone`);
      const { intentId } = await topicNotification(database, fixture);

      const result = await deliverNotificationPush(
        database.sql,
        deliveryOptions(),
        intentId.toString(),
      );

      expect(result).toMatchObject({ sent: 0, removed: 1 });
      expect(store.list()).toEqual([]);
      const [rows] = (await database.sql`
        SELECT count(*)::int AS count FROM pii.push_subscriptions WHERE member_id = ${recipient}
      `) as Array<{ count: number }>;
      expect(rows?.count).toBe(0);
    });
  }, 60_000);

  test("does not send when the recipient lost access before the send", async () => {
    await withPushStack(async ({ database, store, base }) => {
      const fixture = await replyFixture(database);
      const recipient = fixture.starter;
      await sessionToken(database, recipient, "push-lost-session");
      await saveDevice(database, "push-lost-session", `${base}/push/lost`);
      const { intentId } = await topicNotification(database, fixture);
      await database.sql`
        UPDATE core.topics SET visibility = 'soft_deleted' WHERE id = ${fixture.topicId}
      `;

      const result = await deliverNotificationPush(
        database.sql,
        deliveryOptions(),
        intentId.toString(),
      );

      expect(result.sent).toBe(0);
      expect(store.list()).toEqual([]);
    });
  }, 60_000);

  test("never contacts a stored loopback endpoint", async () => {
    await withPushStack(async ({ database, base }) => {
      const fixture = await replyFixture(database);
      const recipient = fixture.starter;
      await sessionToken(database, recipient, "push-loopback-session");
      // Save bypasses endpoint validation, as a malicious direct row would.
      await saveDevice(database, "push-loopback-session", `${base}/push/loopback`);
      const { intentId } = await topicNotification(database, fixture);

      const result = await deliverNotificationPush(
        database.sql,
        {
          vapid: loadVapidConfig({}, "development"),
          fetch: createSafeFetch(),
        },
        intentId.toString(),
      );

      expect(result).toMatchObject({ sent: 0, removed: 1 });
      const [rows] = (await database.sql`
        SELECT count(*)::int AS count FROM pii.push_subscriptions WHERE member_id = ${recipient}
      `) as Array<{ count: number }>;
      expect(rows?.count).toBe(0);
    });
  }, 60_000);

  test("returns the authenticated preview and hides it again after access is lost", async () => {
    await withPushStack(async ({ database }) => {
      const fixture = await replyFixture(database);
      const { notificationId } = await topicNotification(database, fixture);
      const preview = await notificationPreview(
        database.sql,
        fixture.starter,
        notificationId.toString(),
      );

      expect(preview).toMatchObject({
        notificationId: notificationId.toString(),
        titleKey: "push.title.topicReply",
        body: "Push topic with a very secret title",
      });
      expect(preview?.url).toContain(`/topic/${fixture.topicId}-`);

      await database.sql`
        UPDATE core.topics SET visibility = 'soft_deleted' WHERE id = ${fixture.topicId}
      `;
      expect(
        await notificationPreview(database.sql, fixture.starter, notificationId.toString()),
      ).toBeNull();
      expect(
        await notificationPreview(database.sql, fixture.actor, notificationId.toString()),
      ).toBeNull();
    });
  }, 60_000);

  test("respects the web_push flag before creating or sending a push", async () => {
    await withPushStack(async ({ database, store, base }) => {
      const fixture = await replyFixture(database);
      const recipient = fixture.starter;
      await sessionToken(database, recipient, "push-flag-session");
      await saveDevice(database, "push-flag-session", `${base}/push/flag`);
      await setNotificationPreference(database.sql, recipient, "topic.reply", "push", true);
      const { eventId } = fixture;
      const pushIntents: string[] = [];
      const off = {
        enabled: async (key: string) => key !== "web_push",
      };

      const recipientView: NotificationRecipient = {
        memberId: recipient,
        type: "topic.reply",
        source: "follow",
        actorId: fixture.actor,
        topicId: fixture.topicId,
        forumId: fixture.forumId,
        postId: fixture.postId,
      };
      await processNotificationRecipients(
        {
          sql: database.sql,
          flags: off,
          enqueuePush: async (intent: string) => {
            pushIntents.push(intent);
          },
        },
        await requireEvent(database, eventId),
        [recipientView],
      );
      expect(pushIntents).toEqual([]);

      // A stored intent is also skipped by the sender while the flag is off.
      const [row] = (await database.sql`
        SELECT notification_id::text AS id
        FROM core.notification_events
        WHERE event_id = ${eventId} AND member_id = ${recipient}
      `) as Array<{ id: string }>;
      const intentId = await createNotificationPushIntent(
        database.sql,
        recipient,
        BigInt(row?.id ?? "0"),
        eventId,
      );

      if (intentId === null) {
        throw new Error("Missing push intent");
      }

      const delivered = await deliverNotificationPush(
        database.sql,
        { ...deliveryOptions(), flags: off },
        intentId.toString(),
      );
      expect(delivered.sent).toBe(0);
      expect(store.list()).toEqual([]);
    });
  }, 60_000);

  test("creates push intents only for the types the member enabled", async () => {
    await withPushStack(async ({ database, store, base }) => {
      const fixture = await replyFixture(database);
      const recipient = fixture.starter;
      await setNotificationPreference(
        database.sql,
        recipient,
        "conversation.message",
        "push",
        true,
      );
      const conversation = expectOk(
        await startConversation(database.sql, {
          actorId: fixture.actor,
          recipientIds: [recipient],
          title: "A private message",
          bodyMd: "A private message body.",
        }),
      );
      const [event] = (await database.sql`
        SELECT id FROM core.events WHERE type = 'pm.sent' ORDER BY id DESC LIMIT 1
      `) as Array<{ id: bigint | string }>;
      const eventId = BigInt(event?.id ?? 0);
      const pushIntents: string[] = [];
      const options = {
        sql: database.sql,
        enqueuePush: async (intent: string) => {
          pushIntents.push(intent);
        },
      };

      const conversationRecipient: NotificationRecipient = {
        memberId: recipient,
        type: "conversation.message",
        source: "conversation",
        actorId: fixture.actor,
        topicId: null,
        forumId: null,
        postId: null,
        conversationId: conversation.conversationId,
      };
      await processNotificationRecipients(options, await requireEvent(database, eventId), [
        conversationRecipient,
      ]);
      expect(pushIntents).toHaveLength(1);

      const reactionRecipient: NotificationRecipient = {
        memberId: recipient,
        type: "reaction.added",
        source: "reaction",
        actorId: fixture.actor,
        topicId: fixture.topicId,
        forumId: fixture.forumId,
        postId: fixture.postId,
      };
      await processNotificationRecipients(options, await requireEvent(database, fixture.eventId), [
        reactionRecipient,
      ]);
      expect(pushIntents).toHaveLength(1);

      // The PM intent is the one that reaches the mock; the reaction produced none.
      await sessionToken(database, recipient, "push-pm-session");
      await saveDevice(database, "push-pm-session", `${base}/push/pm`);
      const delivered = await deliverNotificationPush(
        database.sql,
        deliveryOptions(),
        pushIntents[0] ?? "",
      );
      expect(delivered.sent).toBe(1);
      expect(store.list()[0]?.body).toMatchObject({ t: "push.title.conversation" });
    });
  }, 60_000);
});

async function requireEvent(database: TestDatabase, eventId: bigint) {
  const event = await loadEvent(database.sql, eventId);

  if (event === null) {
    throw new Error("Missing event");
  }

  return event;
}
