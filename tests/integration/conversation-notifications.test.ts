import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import {
  leaveConversation,
  replyToConversation,
  startConversation,
} from "@bulletin/domain/conversations";
import { loadEvent, type StoredEvent } from "@bulletin/domain/events";
import {
  listNotifications,
  notificationEmailContext,
  setNotificationPreference,
  unreadNotificationCount,
} from "@bulletin/domain/notifications";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { buildNotificationsPage } from "../../apps/user-app/src/account/notifications.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { createNotificationsEventHandler } from "../../apps/workers/src/notifications.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "conversation_notifications" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
      ]),
    });
    await run(database);
  });
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

async function latestEvent(
  database: TestDatabase,
  type: StoredEvent["type"],
): Promise<StoredEvent> {
  const [row] = (await database.sql`
    SELECT id FROM core.events WHERE type = ${type} ORDER BY id DESC LIMIT 1
  `) as Array<{ id: bigint | string }>;

  if (row === undefined) {
    throw new Error(`No ${type} event`);
  }

  const event = await loadEvent(database.sql, BigInt(row.id));

  if (event === null) {
    throw new Error(`Could not load the event`);
  }

  return event;
}

async function startFixture(
  database: TestDatabase,
  starter: string,
  recipient: string,
): Promise<string> {
  const outcome = await startConversation(database.sql, {
    actorId: starter,
    title: "Notification conversation",
    bodyMd: "First message.",
    recipientIds: [recipient],
  });

  if (!outcome.ok) {
    throw new Error(`Could not start the conversation: ${outcome.code}`);
  }

  return outcome.result.conversationId;
}

integrationDescribe("conversation notifications", () => {
  test("notifies the other participant on a new conversation and coalesces replies", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, starter, recipient);
      const handler = createNotificationsEventHandler({ sql: database.sql });

      // The starter's own message must not notify the starter.
      await handler(await latestEvent(database, "pm.sent"));

      let rows = (await database.sql`
        SELECT member_id::text AS member_id, type, actor_id::text AS actor_id,
          conversation_id::text AS conversation_id, count
        FROM core.notifications
        ORDER BY id
      `) as Array<{
        member_id: string;
        type: string;
        actor_id: string;
        conversation_id: string;
        count: number;
      }>;

      expect(rows).toEqual([
        {
          member_id: recipient,
          type: "conversation.message",
          actor_id: starter,
          conversation_id: conversationId,
          count: 1,
        },
      ]);

      const [intent] = (await database.sql`
        SELECT id::text AS id FROM core.delivery_intents
        WHERE member_id = ${recipient} AND kind = 'notification'
        LIMIT 1
      `) as Array<{ id: string }>;
      const email = await notificationEmailContext(database.sql, intent?.id ?? "0");
      expect(email?.conversationId).toBe(conversationId);
      expect(email?.conversationTitle).toBe("Notification conversation");

      const reply = await replyToConversation(database.sql, {
        actorId: recipient,
        conversationId,
        bodyMd: "A reply from the recipient.",
      });
      expect(reply.ok).toBe(true);
      await handler(await latestEvent(database, "pm.sent"));

      rows = (await database.sql`
        SELECT member_id::text AS member_id, type, count
        FROM core.notifications
        ORDER BY id
      `) as Array<{ member_id: string; type: string; count: number }>;

      // The recipient's own reply does not notify them; the starter is notified once and a
      // second reply coalesces into the same unread entry.
      expect(rows).toContainEqual({
        member_id: starter,
        type: "conversation.message",
        count: 1,
      });
      expect(rows.find((row) => row.member_id === recipient)?.count).toBe(1);

      const secondReply = await replyToConversation(database.sql, {
        actorId: recipient,
        conversationId,
        bodyMd: "Another reply.",
      });
      expect(secondReply.ok).toBe(true);
      await handler(await latestEvent(database, "pm.sent"));

      const starterRow = (await database.sql`
        SELECT count FROM core.notifications
        WHERE member_id = ${starter} AND type = 'conversation.message'
      `) as Array<{ count: number }>;
      expect(starterRow[0]?.count).toBe(2);
    });
  }, 30_000);

  test("respects notification preferences and the current participant list", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, starter, recipient);
      const handler = createNotificationsEventHandler({ sql: database.sql });

      for (const channel of ["in_app", "email", "digest"] as const) {
        await setNotificationPreference(
          database.sql,
          recipient,
          "conversation.message",
          channel,
          false,
        );
      }

      await handler(await latestEvent(database, "pm.sent"));
      expect(await listNotifications(database.sql, recipient)).toEqual([]);

      // Re-enable in-app and create one notification, then leave: it disappears from the list.
      await setNotificationPreference(
        database.sql,
        recipient,
        "conversation.message",
        "in_app",
        true,
      );
      const reply = await replyToConversation(database.sql, {
        actorId: starter,
        conversationId,
        bodyMd: "A second message.",
      });
      expect(reply.ok).toBe(true);
      await handler(await latestEvent(database, "pm.sent"));
      expect(await unreadNotificationCount(database.sql, recipient)).toBe(1);

      await leaveConversation(database.sql, { actorId: recipient, conversationId });
      expect(await listNotifications(database.sql, recipient)).toEqual([]);
      expect(await unreadNotificationCount(database.sql, recipient)).toBe(0);
    });
  }, 30_000);

  test("renders a conversation notification with a link to the conversation", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, starter, recipient);
      const handler = createNotificationsEventHandler({ sql: database.sql });
      await handler(await latestEvent(database, "pm.sent"));

      const page = await buildNotificationsPage({
        sql: database.sql,
        memberId: recipient,
        sessionId: null,
        locale: "en",
        translate: createServerT("en", { shipped: USER_CATALOGS }),
      });
      const entry = page.viewModel.sections.flatMap((section) => section.entries)[0];

      expect(entry?.href).toBe(`/conversations/${conversationId}`);
      expect(entry?.text).toContain("Notification conversation");
    });
  }, 30_000);
});
