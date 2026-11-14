import { describe, expect, test } from "bun:test";
import { runBaseSeed } from "@bulletin/db/seed";
import { loadEvent } from "@bulletin/domain/events";
import { createSafeFetch } from "@bulletin/domain/net";
import { loadVapidConfig } from "@bulletin/domain/push";
import { createPushHandler, createPushStore } from "@bulletin/mock-push/server";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { createNotificationsEventHandler } from "../../apps/workers/src/notifications.ts";
import { deliverNotificationPush } from "../../apps/workers/src/push.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

interface Message {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

async function withSeededStack(
  run: (input: {
    readonly database: TestDatabase;
    readonly messages: ReturnType<typeof createPushStore>;
  }) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const messages = createPushStore();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createPushHandler(messages),
  });
  const previous = Bun.env.BULLETIN_SEED_PUSH_ENDPOINT;
  Bun.env.BULLETIN_SEED_PUSH_ENDPOINT = `http://127.0.0.1:${server.port}/push/seed/member-1`;

  try {
    await withTestDatabase({ adminUrl, prefix: "push_seed" }, async (database) => {
      await runBaseSeed({ databaseUrl: database.url, seed: 42, size: "default" });
      await run({ database, messages });
    });
  } finally {
    server.stop(true);

    if (previous === undefined) {
      delete Bun.env.BULLETIN_SEED_PUSH_ENDPOINT;
    } else {
      Bun.env.BULLETIN_SEED_PUSH_ENDPOINT = previous;
    }
  }
}

integrationDescribe("push seed", () => {
  test("seeds a device, a push preference and a PM event that reaches the mock", async () => {
    await withSeededStack(async ({ database, messages }) => {
      const [device] = (await database.sql`
        SELECT p.endpoint, p.label, p.browser_family, p.session_id, i.sub
        FROM pii.push_subscriptions p
        JOIN pii.identities i ON i.member_id = p.member_id
      `) as Array<{
        endpoint: string;
        label: string;
        browser_family: string;
        session_id: string | null;
        sub: string;
      }>;
      expect(device).toMatchObject({
        label: "Seed phone",
        browser_family: "chrome",
        sub: "member-1",
      });
      expect(device?.session_id).toMatch(/^\d+$/);
      expect(device?.endpoint).toContain("/push/seed/member-1");

      const [preference] = (await database.sql`
        SELECT p.enabled
        FROM core.notification_preferences p
        JOIN pii.identities i ON i.member_id = p.member_id
        WHERE i.sub = 'member-1' AND p.type = 'conversation.message' AND p.channel = 'push'
      `) as Array<{ enabled: boolean }>;
      expect(preference?.enabled).toBe(true);

      const [eventRow] = (await database.sql`
        SELECT id FROM core.events WHERE type = 'pm.sent' ORDER BY id DESC LIMIT 1
      `) as Array<{ id: bigint | string }>;
      const event =
        eventRow === undefined ? null : await loadEvent(database.sql, BigInt(eventRow.id));
      expect(event).not.toBeNull();

      if (event === null) {
        throw new Error("Missing the seeded pm.sent event");
      }

      const pushIntents: string[] = [];
      await createNotificationsEventHandler({
        sql: database.sql,
        enqueuePush: async (intentId) => {
          pushIntents.push(intentId);
        },
      })(event);

      expect(pushIntents).toHaveLength(1);
      const delivered = await deliverNotificationPush(
        database.sql,
        {
          vapid: loadVapidConfig({}, "development"),
          fetch: createSafeFetch({ devAllow: ["127.0.0.1"] }),
        },
        pushIntents[0] ?? "",
      );

      expect(delivered.sent).toBe(1);
      const message = messages.list()[0] as Message | undefined;
      expect(message?.headers["content-encoding"]).toBe("aes128gcm");
      expect(message?.headers.authorization?.startsWith("vapid t=")).toBe(true);
      expect(message?.body).toMatchObject({ t: "push.title.conversation" });
      expect(Object.keys((message?.body as object) ?? {}).sort()).toEqual(["n", "t"]);
      expect(JSON.stringify(message?.body)).not.toContain("Weekend plans");
      expect(JSON.stringify(message?.body)).not.toContain("booked the table");
    });
  }, 120_000);
});
