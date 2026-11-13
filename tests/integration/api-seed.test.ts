import { describe, expect, test } from "bun:test";
import { runBaseSeed } from "@bulletin/db/seed";
import { loadEvent } from "@bulletin/domain/events";
import {
  attemptWebhookDelivery,
  buildWebhookPayload,
  createWebhookDelivery,
  listWebhooks,
  readWebhook,
} from "@bulletin/domain/webhooks";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { createWebhookHandler, createWebhookStore } from "../../mocks/webhooks/src/app.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "api_seed" }, async (database) => {
    const previous = Bun.env.BULLETIN_SEED_WEBHOOK_URL;
    Bun.env.BULLETIN_SEED_WEBHOOK_URL = "http://webhooks:4004/hook";

    try {
      await runBaseSeed({ databaseUrl: database.url, seed: 42, size: "default" });
    } finally {
      if (previous === undefined) {
        delete Bun.env.BULLETIN_SEED_WEBHOOK_URL;
      } else {
        Bun.env.BULLETIN_SEED_WEBHOOK_URL = previous;
      }
    }

    await run(database);
  });
}

integrationDescribe("public API seed", () => {
  test("seeds a personal key, an integration key and a deliverable webhook", async () => {
    await withSeededDb(async (database) => {
      const keys = (await database.sql`
        SELECT k.kind, k.label, k.prefix, m.display_name, m.is_service
        FROM core.api_keys k
        JOIN core.members m ON m.id = k.principal_member_id
        ORDER BY k.kind, k.id
      `) as Array<{
        kind: string;
        label: string;
        prefix: string;
        display_name: string;
        is_service: boolean;
      }>;

      expect(keys).toHaveLength(2);
      expect(keys.find((key) => key.kind === "personal")).toMatchObject({
        label: "Seed personal key",
        display_name: "Miembro Español",
        is_service: false,
      });
      expect(keys.find((key) => key.kind === "integration")).toMatchObject({
        label: "Integration Bot",
        display_name: "Integration Bot",
        is_service: true,
      });

      const webhooks = await listWebhooks(database.sql);
      expect(webhooks).toHaveLength(1);
      expect(webhooks[0]).toMatchObject({
        url: "http://webhooks:4004/hook",
        enabled: true,
        principalName: "Integration Bot",
        events: ["topic.created", "post.created", "post.edited"],
      });

      const webhook = await readWebhook(database.sql, webhooks[0]?.id ?? "");
      if (webhook === null) {
        throw new Error("Missing seeded webhook");
      }

      const [eventRow] = (await database.sql`
        SELECT id FROM core.events WHERE type = 'post.edited' ORDER BY id DESC LIMIT 1
      `) as Array<{ id: string }>;
      const event =
        eventRow === undefined ? null : await loadEvent(database.sql, BigInt(eventRow.id));

      if (event === null) {
        throw new Error("Missing seeded post.edited event");
      }

      const payload = await buildWebhookPayload(database.sql, webhook, event);
      expect(payload?.type).toBe("post.edited");
      expect(String(payload?.data.url)).toMatch(/^\/topic\/\d+-/);
      expect(payload).not.toHaveProperty("content");

      const deliveryId = await createWebhookDelivery(database.sql, {
        webhookId: webhook.id,
        eventId: event.id.toString(),
        attempt: 1,
      });

      if (deliveryId === null) {
        throw new Error("Could not create seeded delivery");
      }

      const store = createWebhookStore();
      const handler = createWebhookHandler(store, "bulletin-dev-webhook-secret-0123456789");
      const result = await attemptWebhookDelivery(database.sql, deliveryId, {
        fetch: async (input, init) => handler(new Request(String(input), init as RequestInit)),
      });

      expect(result?.status).toBe("delivered");
      expect(store.list()[0]?.signatureValid).toBe(true);
      expect(JSON.parse(store.list()[0]?.body ?? "{}")).toMatchObject({
        type: "post.edited",
      });
    });
  }, 60_000);
});
