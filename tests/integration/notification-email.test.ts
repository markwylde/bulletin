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
import { loadEvent } from "@bulletin/domain/events";
import {
  createNotification,
  createNotificationEmailIntent,
  createUnsubscribeToken,
  listNotifications,
  type NotificationType,
  setNotificationPreference,
  verifyUnsubscribeToken,
} from "@bulletin/domain/notifications";
import { reply, startTopic } from "@bulletin/domain/topics";
import { createMailStore } from "@bulletin/mock-mail/message";
import { startSmtpServer } from "@bulletin/mock-mail/smtp";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { userOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import {
  deliverNotificationEmail,
  type EmailOptions,
  UNSUBSCRIBE_TOKEN_TTL_MS,
} from "../../apps/workers/src/email.ts";
import { createNotificationsEventHandler } from "../../apps/workers/src/notifications.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const SECRET = "notification-email-secret";

function roleUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function withMailStack(
  run: (context: {
    readonly database: TestDatabase;
    readonly store: ReturnType<typeof createMailStore>;
    readonly options: EmailOptions;
  }) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const store = createMailStore();
  const server = startSmtpServer({ port: 0, store, hostname: "127.0.0.1" });

  try {
    await withTestDatabase({ adminUrl, prefix: "notification_email" }, async (database) => {
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

      await run({
        database,
        store,
        options: {
          smtpUrl: `smtp://127.0.0.1:${server.port}`,
          mailFrom: "Bulletin <no-reply@bulletin.test>",
          userOrigin: userOrigin(),
          unsubscribeSecret: SECRET,
        },
      });
    });
  } finally {
    server.stop();
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

async function emailFor(database: TestDatabase, memberIdValue: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT email FROM pii.identities WHERE member_id = ${memberIdValue}
  `) as Array<{ email: string }>;

  if (row === undefined) {
    throw new Error("Missing email");
  }

  return row.email;
}

async function requireEvent(database: TestDatabase, eventId: bigint) {
  const event = await loadEvent(database.sql, eventId);

  if (event === null) {
    throw new Error("Missing event");
  }

  return event;
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
      title: "Email topic",
      bodyMd: "Quoted secret source body.",
    }),
  );
  const post = expectOk(
    await reply(database.sql, {
      actorId: actor,
      topicId: topic.topicId,
      bodyMd: "Quoted secret source body.",
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

async function createIntent(
  database: TestDatabase,
  fixture: Fixture,
  memberIdValue: string,
  type: NotificationType,
): Promise<{ readonly notificationId: bigint; readonly intentId: bigint }> {
  const [event] = (await database.sql`
    SELECT id FROM core.events ORDER BY id DESC LIMIT 1
  `) as Array<{ id: bigint | string }>;
  const eventId = BigInt(event?.id ?? fixture.eventId);
  const notificationId = await createNotification(database.sql, {
    memberId: memberIdValue,
    type,
    eventId,
    actorId: fixture.actor,
    topicId: fixture.topicId,
    forumId: fixture.forumId,
    postId: fixture.postId,
  });

  if (notificationId === null) {
    throw new Error("Notification was deduplicated");
  }

  const intentId = await createNotificationEmailIntent(
    database.sql,
    memberIdValue,
    notificationId,
    eventId,
  );

  if (intentId === null) {
    throw new Error("No email intent");
  }

  return { notificationId, intentId };
}

integrationDescribe("notification email", () => {
  test("delivers a localised, quote-free email and audits the delivery", async () => {
    await withMailStack(async ({ database, store, options }) => {
      const fixture = await replyFixture(database);
      const intentIds: string[] = [];
      await createNotificationsEventHandler({
        sql: database.sql,
        async enqueueEmail(intentId) {
          intentIds.push(intentId);
        },
      })(await requireEvent(database, fixture.eventId));

      expect(intentIds).toHaveLength(1);
      const result = await deliverNotificationEmail(database.sql, options, intentIds[0] ?? "");

      expect(result).toBe("sent");
      const messages = store.list();
      expect(messages).toHaveLength(1);
      const message = messages[0];
      expect(message?.to).toEqual([await emailFor(database, fixture.starter)]);
      expect(message?.subject).toBe("New reply in Email topic");
      expect(message?.text).toContain('Regular Member One replied in "Email topic".');
      expect(message?.text).not.toContain("Quoted secret source body.");
      expect(message?.html).not.toContain("Quoted secret source body.");
      expect(message?.html).toContain("Email topic");
      // RFC 8058 headers point at the one-click endpoint; the body links to the confirmation page.
      expect(message?.headers["list-unsubscribe"]).toContain(
        `${userOrigin()}/api/notifications/unsubscribe?token=`,
      );
      expect(message?.headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
      expect(message?.text).toMatch(/\/unsubscribe\?token=/);

      const token = /unsubscribe\?token=([^>\s]+)/.exec(message?.text ?? "")?.[1];
      expect(token).toBeString();
      const claims = verifyUnsubscribeToken(SECRET, decodeURIComponent(token ?? ""));
      expect(claims).toMatchObject({
        memberId: fixture.starter,
        type: "topic.reply",
        expiresAt: expect.any(Number),
      });

      const [intent] = (await database.sql`
        SELECT delivered_at FROM core.delivery_intents WHERE id = ${intentIds[0] ?? "0"}
      `) as Array<{ delivered_at: Date | null }>;
      expect(intent?.delivered_at).not.toBeNull();

      const [audit] = (await database.sql`
        SELECT purpose, subject_member_id::text AS member_id, resource_id
        FROM pii.access_log
        WHERE purpose = 'delivery'
      `) as Array<{ purpose: string; member_id: string; resource_id: string }>;
      expect(audit).toEqual({
        purpose: "delivery",
        member_id: fixture.starter,
        resource_id: intentIds[0] ?? "",
      });

      // A delivered intent cannot be read again.
      expect(await deliverNotificationEmail(database.sql, options, intentIds[0] ?? "")).toBe(
        "skipped",
      );
      expect(store.list()).toHaveLength(1);
    });
  }, 60_000);

  test("each reply is emailed even when the in-app notification coalesces", async () => {
    await withMailStack(async ({ database, store, options }) => {
      const fixture = await replyFixture(database);
      const intents: string[] = [];
      const handler = createNotificationsEventHandler({
        sql: database.sql,
        async enqueueEmail(intentId) {
          intents.push(intentId);
        },
      });

      await handler(await requireEvent(database, fixture.eventId));
      expect(intents).toHaveLength(1);
      expect(await deliverNotificationEmail(database.sql, options, intents[0] ?? "")).toBe("sent");

      const second = expectOk(
        await reply(database.sql, {
          actorId: fixture.actor,
          topicId: fixture.topicId,
          bodyMd: "A second reply.",
        }),
      );
      const [secondEvent] = (await database.sql`
        SELECT id FROM core.events WHERE type = 'post.created' ORDER BY id DESC LIMIT 1
      `) as Array<{ id: bigint | string }>;
      await handler(await requireEvent(database, BigInt(secondEvent?.id ?? 0)));

      expect(intents).toHaveLength(2);
      expect(intents[0]).not.toBe(intents[1]);
      expect(await deliverNotificationEmail(database.sql, options, intents[1] ?? "")).toBe("sent");
      const messages = store.list();
      expect(messages).toHaveLength(2);
      // Each queued intent keeps its own source event's post link, not the coalesced latest one.
      const firstMail = messages.find((message) =>
        message.text.includes(`/post/${fixture.postId}`),
      );
      const secondMail = messages.find((message) =>
        message.text.includes(`/post/${second.postId}`),
      );
      expect(firstMail).toBeDefined();
      expect(secondMail).toBeDefined();
      expect(firstMail?.text).not.toContain(`/post/${second.postId}`);
    });
  }, 60_000);

  test("sends in French to a French member", async () => {
    await withMailStack(async ({ database, store, options }) => {
      const fixture = await replyFixture(database);
      const french = await memberId(database, "member-fr");
      const { intentId } = await createIntent(database, fixture, french, "topic.reply");

      expect(await deliverNotificationEmail(database.sql, options, intentId.toString())).toBe(
        "sent",
      );

      const message = store.list()[0];
      const encoded = /=\?UTF-8\?B\?([^?]+)\?=/.exec(message?.subject ?? "")?.[1];
      const subject =
        encoded === undefined
          ? (message?.subject ?? "")
          : Buffer.from(encoded, "base64").toString("utf8");
      expect(subject).toContain("Nouvelle réponse");
      expect(message?.text).toContain("a répondu");
      expect(message?.to).toEqual([await emailFor(database, french)]);
    });
  }, 60_000);

  test("delivers a reputation email built from the giver and no post body", async () => {
    await withMailStack(async ({ database, store, options }) => {
      const fixture = await replyFixture(database);
      const { intentId } = await createIntent(
        database,
        fixture,
        fixture.starter,
        "reputation.given",
      );

      expect(await deliverNotificationEmail(database.sql, options, intentId.toString())).toBe(
        "sent",
      );

      const message = store.list()[0];
      const encoded = /=\?UTF-8\?B\?([^?]+)\?=/.exec(message?.subject ?? "")?.[1];
      const subject =
        encoded === undefined
          ? (message?.subject ?? "")
          : Buffer.from(encoded, "base64").toString("utf8");
      expect(subject).toContain("New reputation");
      expect(message?.text).toContain("You received reputation");
      expect(message?.text).not.toContain("Regular Member One");
      expect(message?.text).not.toContain("The first post");
    });
  }, 60_000);

  test("an email-disabled notification stays in the app and sends nothing", async () => {
    await withMailStack(async ({ database, store, options }) => {
      const fixture = await replyFixture(database);
      const member = fixture.starter;
      await setNotificationPreference(database.sql, member, "reaction.added", "email", false);
      const { notificationId, intentId } = await createIntent(
        database,
        fixture,
        member,
        "reaction.added",
      );

      expect(await deliverNotificationEmail(database.sql, options, intentId.toString())).toBe(
        "skipped",
      );
      expect(store.list()).toEqual([]);

      const [notification] = (await database.sql`
        SELECT read_at FROM core.notifications WHERE id = ${notificationId}
      `) as Array<{ read_at: Date | null }>;
      expect(notification?.read_at).toBeNull();
      // The in-app notification is still there: only the email channel was disabled.
      expect(
        (await listNotifications(database.sql, member)).some(
          (entry) => entry.id === notificationId.toString() && entry.type === "reaction.added",
        ),
      ).toBe(true);

      const [intent] = (await database.sql`
        SELECT delivered_at FROM core.delivery_intents WHERE id = ${intentId}
      `) as Array<{ delivered_at: Date | null }>;
      expect(intent?.delivered_at).toBeNull();
    });
  }, 60_000);

  test("system mail resolves the address but respects the erasure fence", async () => {
    await withMailStack(async ({ database }) => {
      const member = await memberId(database, "member-1");
      const worker = new SQL(roleUrl(database.url, "workers"));

      try {
        const [row] = (await worker`
          INSERT INTO core.delivery_intents (member_id, kind, ref_id, channel)
          VALUES (${member}, 'system', 1, 'email')
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        const [target] = (await worker`
          SELECT pii.delivery_target(${row?.id ?? "0"}, 'email') AS email
        `) as Array<{ email: string | null }>;
        expect(target?.email).toBe(await emailFor(database, member));

        await database.sql`UPDATE core.members SET state = 'erasing' WHERE id = ${member}`;
        const [refused] = (await worker`
          SELECT pii.delivery_target(${row?.id ?? "0"}, 'email') AS email
        `) as Array<{ email: string | null }>;
        expect(refused?.email).toBeNull();
      } finally {
        await worker.close();
      }
    });
  }, 60_000);

  test("an erasing member's pending notification email is never sent", async () => {
    await withMailStack(async ({ database, store, options }) => {
      const fixture = await replyFixture(database);
      const { notificationId, intentId } = await createIntent(
        database,
        fixture,
        fixture.starter,
        "topic.reply",
      );
      await database.sql`
        UPDATE core.members SET state = 'erasing' WHERE id = ${fixture.starter}
      `;

      expect(await deliverNotificationEmail(database.sql, options, intentId.toString())).toBe(
        "skipped",
      );
      expect(store.list()).toEqual([]);

      const [intent] = (await database.sql`
        SELECT delivered_at FROM core.delivery_intents WHERE id = ${intentId}
      `) as Array<{ delivered_at: Date | null }>;
      expect(intent?.delivered_at).toBeNull();

      const [notification] = (await database.sql`
        SELECT read_at FROM core.notifications WHERE id = ${notificationId}
      `) as Array<{ read_at: Date | null }>;
      expect(notification?.read_at).toBeNull();
    });
  }, 60_000);

  test("workers cannot read identities or target arbitrary intents", async () => {
    await withMailStack(async ({ database }) => {
      const worker = new SQL(roleUrl(database.url, "workers"));

      try {
        let denied = false;

        try {
          await worker`SELECT 1 FROM pii.identities LIMIT 1`;
        } catch (error) {
          denied = /permission/i.test(String(error));
        }

        expect(denied).toBe(true);
        const [missing] = (await worker`
          SELECT pii.delivery_target(999999999, 'email') AS email
        `) as Array<{ email: string | null }>;
        expect(missing?.email).toBeNull();
        const [channel] = (await worker`
          SELECT pii.delivery_target(1, 'sms') AS email
        `) as Array<{ email: string | null }>;
        expect(channel?.email).toBeNull();
      } finally {
        await worker.close();
      }
    });
  }, 30_000);

  test("unsubscribe tokens are signed, scoped and expiring", () => {
    const claims = {
      memberId: "7",
      type: "topic.reply" as const,
      expiresAt: Date.now() + UNSUBSCRIBE_TOKEN_TTL_MS,
    };
    const token = createUnsubscribeToken(SECRET, claims);

    expect(verifyUnsubscribeToken(SECRET, token)).toEqual(claims);
    expect(verifyUnsubscribeToken("other-secret", token)).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, `${token}x`)).toBeNull();
    expect(
      verifyUnsubscribeToken(
        SECRET,
        createUnsubscribeToken(SECRET, { ...claims, expiresAt: Date.now() - 1 }),
      ),
    ).toBeNull();
  });
});
