import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createWebhookEventHandler, purgeWebhookDeliveries } from "@bulletin/db/jobs";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { createIntegrationApiKey } from "@bulletin/domain/api";
import { loadEvent } from "@bulletin/domain/events";
import type { SafeFetch } from "@bulletin/domain/net";
import { reply, startTopic } from "@bulletin/domain/topics";
import {
  attemptWebhookDelivery,
  buildWebhookPayload,
  createWebhookDelivery,
  disableExpiredWebhooks,
  listWebhookDeliveries,
  nextWebhookAttempt,
  pendingWebhookDeliveries,
  readWebhook,
  saveWebhook,
  validateWebhookTarget,
  WEBHOOK_FAILURE_WINDOW_MS,
  webhookRetryDelayMs,
} from "@bulletin/domain/webhooks";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authorizeStaffRoute, STAFF_ROUTES } from "../../apps/staff-api/src/api.ts";
import { mutateWebhookForStaff, webhooksResponse } from "../../apps/staff-api/src/webhooks.ts";
import { createWebhookHandler, createWebhookStore } from "../../mocks/webhooks/src/app.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const PEPPER = "webhook-test-key-pepper";
const MOCK_SECRET = "bulletin-dev-webhook-secret-0123456789";

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "webhooks" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
      ]),
    });
    // These tests exercise webhook fanout; remove the demo webhook so assertions describe only
    // the webhook each test creates.
    await database.sql`DELETE FROM core.webhooks`;
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

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

async function servicePrincipal(
  database: TestDatabase,
  label: string,
  groupKey = "members",
): Promise<string> {
  const [group] = (await database.sql`
    SELECT id::text AS id FROM core.groups WHERE key = ${groupKey}
  `) as Array<{ id: string }>;
  const key = await createIntegrationApiKey(database.sql, {
    label,
    groupIds: [group?.id ?? ""],
    scopes: ["read:topics"],
    pepper: PEPPER,
  });
  const [principal] = (await database.sql`
    SELECT principal_member_id::text AS member_id
    FROM core.api_keys
    WHERE id = ${key.metadata.id}
  `) as Array<{ member_id: string }>;

  if (principal === undefined) {
    throw new Error("Missing service principal");
  }

  return principal.member_id;
}

async function createWebhook(
  database: TestDatabase,
  principalMemberId: string,
  events: readonly string[],
  contentFields: readonly string[] = [],
  url = "http://webhooks:4004/hook",
) {
  const result = await saveWebhook(database.sql, {
    url,
    events,
    principalMemberId,
    contentFields,
    enabled: true,
    actorId: principalMemberId,
  });

  if (!result.ok || result.secret === null) {
    throw new Error(`Could not create webhook: ${result.ok ? "missing secret" : result.code}`);
  }

  return { webhook: result.webhook, secret: result.secret, url };
}

function mockFetch(secret: string): {
  readonly fetch: SafeFetch;
  readonly store: ReturnType<typeof createWebhookStore>;
} {
  const store = createWebhookStore();
  const handler = createWebhookHandler(store, secret);

  return {
    store,
    fetch: async (input, init) => handler(new Request(String(input), init as RequestInit)),
  };
}

function failingFetch(): SafeFetch {
  return async () => new Response("nope", { status: 500 });
}

async function latestEvent(database: TestDatabase, type: string): Promise<bigint> {
  const [row] = (await database.sql`
    SELECT id FROM core.events WHERE type = ${type} ORDER BY id DESC LIMIT 1
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing event ${type}`);
  }

  return BigInt(row.id);
}

async function createPublicTopicAndReply(
  database: TestDatabase,
  forum: string,
  author: string,
  title: string,
): Promise<{ readonly topicId: string; readonly postId: string }> {
  const created = await startTopic(database.sql, {
    actorId: author,
    forumId: forum,
    title,
    bodyMd: "Topic body.",
  });

  if (!created.ok) {
    throw new Error("Could not create the topic");
  }

  const replied = await reply(database.sql, {
    actorId: author,
    topicId: created.result.topicId,
    bodyMd: "Reply body that must not leak by default.",
  });

  if (!replied.ok) {
    throw new Error("Could not create the reply");
  }

  return { topicId: created.result.topicId, postId: replied.result.postId };
}

describe("webhook target validation", () => {
  test("rejects private targets in production and accepts an explicit dev mock", async () => {
    await expect(
      validateWebhookTarget("http://192.168.1.10/hook", {
        nodeEnv: "production",
        resolve: async () => ["93.184.216.34"],
      }),
    ).resolves.toEqual({ ok: false, code: "https_required" });

    await expect(
      validateWebhookTarget("https://192.168.1.10/hook", {
        nodeEnv: "production",
        resolve: async () => ["192.168.1.10"],
      }),
    ).resolves.toEqual({ ok: false, code: "blocked_address" });

    await expect(
      validateWebhookTarget("http://webhooks:4004/hook", {
        nodeEnv: "development",
        devAllow: ["webhooks"],
        resolve: async () => ["10.0.0.5"],
      }),
    ).resolves.toEqual({ ok: true, url: "http://webhooks:4004/hook" });
  });
});

describe("webhook retry policy", () => {
  test("backs off exponentially and caps at six hours", () => {
    expect(webhookRetryDelayMs(1)).toBe(30_000);
    expect(webhookRetryDelayMs(2)).toBe(60_000);
    expect(webhookRetryDelayMs(3)).toBe(120_000);
    expect(webhookRetryDelayMs(20)).toBe(6 * 60 * 60 * 1_000);
  });
});

integrationDescribe("webhook configuration", () => {
  test("rejects a private production target and a caller without acp.webhooks", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const principal = await servicePrincipal(database, "Config Bot");
      const response = await mutateWebhookForStaff(
        database.sql,
        member,
        new Request("http://staff.bulletin.localhost/api/staff/webhooks", {
          method: "POST",
          body: JSON.stringify({
            action: "save",
            url: "http://192.168.1.10/hook",
            principalMemberId: principal,
            events: ["post.created"],
            contentFields: [],
          }),
        }),
        { target: { nodeEnv: "production", devAllow: [] } },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid_target", reason: "https_required" });

      const saved = await mutateWebhookForStaff(
        database.sql,
        member,
        new Request("http://staff.bulletin.localhost/api/staff/webhooks", {
          method: "POST",
          body: JSON.stringify({
            action: "save",
            url: "http://webhooks:4004/hook",
            principalMemberId: principal,
            events: ["post.created"],
            contentFields: [],
          }),
        }),
        { target: { nodeEnv: "development", devAllow: ["webhooks"] } },
      );
      expect(saved.status).toBe(200);
      const savedBody = (await saved.json()) as { secret?: string };
      expect(savedBody.secret).toMatch(/^[A-Za-z0-9_-]{32,}$/);

      const list = await webhooksResponse(database.sql);
      const listed = (await list.json()) as { webhooks: Array<Record<string, unknown>> };
      expect(listed.webhooks).toHaveLength(1);
      expect(listed.webhooks[0]).not.toHaveProperty("secret");

      const route = STAFF_ROUTES.find((entry) => entry.id === "webhooks.mutate");
      expect(route?.permission).toBe("acp.webhooks");

      if (route === undefined) {
        throw new Error("Missing webhooks.mutate route");
      }

      const denied = await authorizeStaffRoute(route, {
        request: new Request("http://staff.bulletin.localhost/api/staff/webhooks"),
        url: new URL("http://staff.bulletin.localhost/api/staff/webhooks"),
        session: {
          id: "1",
          memberId: member,
          kind: "staff",
          displayName: "Regular Member One",
          createdAt: new Date(),
          lastSeenAt: new Date(),
          reauthAt: new Date(),
          lastAuthAt: new Date(),
          reauthRetryCount: 0,
          revokedAt: null,
          rotatePending: false,
          viaPreviousToken: false,
          previousTokenExpiresAt: null,
        },
        sql: database.sql,
        checks: [],
      });
      expect(denied.status).toBe(403);
    });
  }, 30_000);

  test("accepts the local mock target through the staff allowlist environment", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const principal = await servicePrincipal(database, "Allowlist Bot");
      const previous = Bun.env.SAFE_FETCH_DEV_ALLOW;
      Bun.env.SAFE_FETCH_DEV_ALLOW = "webhooks";

      try {
        const response = await mutateWebhookForStaff(
          database.sql,
          member,
          new Request("http://staff.bulletin.localhost/api/staff/webhooks", {
            method: "POST",
            body: JSON.stringify({
              action: "save",
              url: "http://webhooks:4004/hook",
              principalMemberId: principal,
              events: ["post.created"],
              contentFields: [],
            }),
          }),
        );

        expect(response.status).toBe(200);
      } finally {
        if (previous === undefined) {
          delete Bun.env.SAFE_FETCH_DEV_ALLOW;
        } else {
          Bun.env.SAFE_FETCH_DEV_ALLOW = previous;
        }
      }
    });
  }, 30_000);
});

integrationDescribe("webhook subscriber and delivery", () => {
  test("delivers a minimal signed post.created payload to the webhook mock", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const principal = await servicePrincipal(database, "Delivery Bot");
      const { webhook, secret } = await createWebhook(database, principal, ["post.created"]);
      const content = await createPublicTopicAndReply(database, forum, author, "Webhook topic");
      const eventId = await latestEvent(database, "post.created");
      const event = await loadEvent(database.sql, eventId);

      if (event === null) {
        throw new Error("Missing event");
      }

      const payload = await buildWebhookPayload(database.sql, webhook, event);
      expect(payload?.data).toMatchObject({
        postId: content.postId,
        topicId: content.topicId,
      });
      expect(String(payload?.data.url)).toMatch(/^\/topic\/\d+-webhook-topic/);
      expect(payload).not.toHaveProperty("content");

      const deliveryId = await createWebhookDelivery(database.sql, {
        webhookId: webhook.id,
        eventId: eventId.toString(),
        attempt: 1,
      });

      if (deliveryId === null) {
        throw new Error("Could not create delivery");
      }

      const mock = mockFetch(secret);
      const result = await attemptWebhookDelivery(database.sql, deliveryId, {
        fetch: mock.fetch,
      });

      expect(result?.status).toBe("delivered");
      const [captured] = mock.store.list();
      expect(captured).toBeDefined();
      expect(captured?.signatureValid).toBe(true);
      expect(captured?.body).not.toContain("Reply body that must not leak by default.");
      expect(JSON.parse(captured?.body ?? "{}")).not.toHaveProperty("content");

      const timestamp = captured?.headers["x-bulletin-timestamp"] ?? "";
      const expected = createHmac("sha256", secret)
        .update(`${timestamp}.${captured?.body ?? ""}`)
        .digest("hex");
      expect(captured?.headers["x-bulletin-signature"]).toBe(`sha256=${expected}`);

      const log = await listWebhookDeliveries(database.sql, { webhookId: webhook.id });
      expect(log[0]).toMatchObject({
        status: "delivered",
        httpStatus: 202,
        eventType: "post.created",
        attempt: 1,
      });
      expect(log[0]?.responseMs).not.toBeNull();
    });
  }, 30_000);

  test("fans a relay event out to one pending webhook attempt", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const principal = await servicePrincipal(database, "Relay Bot");
      await createWebhook(database, principal, ["post.created"]);
      await createPublicTopicAndReply(database, forum, author, "Relay topic");
      const event = await loadEvent(database.sql, await latestEvent(database, "post.created"));

      if (event === null) {
        throw new Error("Missing event");
      }

      const sent: Array<{ readonly queue: string; readonly deliveryId: string }> = [];
      const boss = {
        send: async (queue: string, payload: { readonly deliveryId: string }): Promise<string> => {
          sent.push({ queue, deliveryId: payload.deliveryId });
          return "job";
        },
      } as unknown as import("pg-boss").PgBoss;
      const handler = createWebhookEventHandler({ boss, sql: database.sql });
      await handler(event);

      expect(sent).toHaveLength(1);
      expect(sent[0]?.queue).toBe("webhooks");

      const deliveries = await listWebhookDeliveries(database.sql);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        eventType: "post.created",
        attempt: 1,
        status: "pending",
      });
    });
  }, 30_000);

  test("stops fanout and queued deliveries when the webhooks flag is off", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const principal = await servicePrincipal(database, "Flagged Bot");
      const { webhook, secret } = await createWebhook(database, principal, ["post.created"]);
      await createPublicTopicAndReply(database, forum, author, "Flagged webhook topic");
      const event = await loadEvent(database.sql, await latestEvent(database, "post.created"));

      if (event === null) {
        throw new Error("Missing event");
      }

      const sent: string[] = [];
      const boss = {
        send: async (_queue: string, payload: { readonly deliveryId: string }): Promise<string> => {
          sent.push(payload.deliveryId);
          return "job";
        },
      } as unknown as import("pg-boss").PgBoss;
      const offHandler = createWebhookEventHandler({
        boss,
        sql: database.sql,
        isEnabled: async () => false,
      });
      await offHandler(event);
      expect(sent).toHaveLength(0);
      expect(await listWebhookDeliveries(database.sql, { webhookId: webhook.id })).toHaveLength(0);

      const onHandler = createWebhookEventHandler({
        boss,
        sql: database.sql,
        isEnabled: async () => true,
      });
      await onHandler(event);
      expect(sent).toHaveLength(1);

      const deliveryId = sent[0];
      const mock = mockFetch(secret);
      const skipped = await attemptWebhookDelivery(database.sql, deliveryId ?? "", {
        fetch: mock.fetch,
        isEnabled: async () => false,
      });

      expect(skipped?.status).toBe("skipped");
      expect(skipped?.error).toBe("feature_disabled");
      expect(mock.store.list()).toHaveLength(0);
      expect(
        (await listWebhookDeliveries(database.sql, { webhookId: webhook.id }))[0],
      ).toMatchObject({ status: "skipped", httpStatus: null });
    });
  }, 30_000);

  test("purges delivery logs after the 30-day retention boundary", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const principal = await servicePrincipal(database, "Retention Bot");
      const { webhook } = await createWebhook(database, principal, ["post.created"]);
      await createPublicTopicAndReply(database, forum, author, "Retention topic");
      const eventId = await latestEvent(database, "post.created");
      const old = await createWebhookDelivery(database.sql, {
        webhookId: webhook.id,
        eventId: eventId.toString(),
        attempt: 1,
      });
      const recent = await createWebhookDelivery(database.sql, {
        webhookId: webhook.id,
        eventId: eventId.toString(),
        attempt: 2,
      });

      if (old === null || recent === null) {
        throw new Error("Could not create retention rows");
      }

      await database.sql`
        UPDATE core.webhook_deliveries
        SET created_at = ${new Date("2026-01-01T00:00:00.000Z")}
        WHERE id = ${old}
      `;
      await database.sql`
        UPDATE core.webhook_deliveries
        SET created_at = ${new Date("2026-01-20T00:00:00.000Z")}
        WHERE id = ${recent}
      `;

      expect(await purgeWebhookDeliveries(database.sql, new Date("2026-02-01T00:00:00.000Z"))).toBe(
        1,
      );
      const remaining = (await database.sql`
        SELECT id::text AS id FROM core.webhook_deliveries
        WHERE id = ANY(${`{${old},${recent}}`}::bigint[])
      `) as Array<{ id: string }>;
      expect(remaining.map((row) => row.id)).toEqual([recent]);
    });
  }, 30_000);

  test("does not deliver a staff-forum event to a principal that cannot read it", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const staffForum = await forumId(database, "staff-room");
      const principal = await servicePrincipal(database, "Staff Blind Bot");
      const { webhook, secret } = await createWebhook(database, principal, ["topic.created"]);
      const created = await startTopic(database.sql, {
        actorId: admin,
        forumId: staffForum,
        title: "Private webhook event",
        bodyMd: "Staff only.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      const eventId = await latestEvent(database, "topic.created");
      const event = await loadEvent(database.sql, eventId);

      if (event === null) {
        throw new Error("Missing event");
      }

      expect(await buildWebhookPayload(database.sql, webhook, event)).toBeNull();

      const deliveryId = await createWebhookDelivery(database.sql, {
        webhookId: webhook.id,
        eventId: eventId.toString(),
        attempt: 1,
      });

      if (deliveryId === null) {
        throw new Error("Could not create delivery");
      }

      const mock = mockFetch(secret);
      const result = await attemptWebhookDelivery(database.sql, deliveryId, {
        fetch: mock.fetch,
      });
      expect(result?.status).toBe("skipped");
      expect(mock.store.list()).toHaveLength(0);
    });
  }, 30_000);

  test("includes opted-in content fields but still never restricted data", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const principal = await servicePrincipal(database, "Content Bot");
      const { webhook } = await createWebhook(
        database,
        principal,
        ["topic.created"],
        ["title", "bodyText"],
      );
      const created = await startTopic(database.sql, {
        actorId: author,
        forumId: forum,
        title: "Content topic",
        bodyMd: "Visible topic body.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      const event = await loadEvent(database.sql, await latestEvent(database, "topic.created"));

      if (event === null) {
        throw new Error("Missing event");
      }

      const payload = await buildWebhookPayload(database.sql, webhook, event);
      expect(payload?.content).toEqual({
        title: "Content topic",
        bodyText: "Visible topic body.",
      });
      expect(JSON.stringify(payload)).not.toContain("member-1@bulletin.test");
    });
  }, 30_000);

  test("re-sanitises stale HTML before including it in a webhook", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const principal = await servicePrincipal(database, "Sanitiser Bot");
      const { webhook } = await createWebhook(database, principal, ["topic.created"], ["bodyHtml"]);
      const created = await startTopic(database.sql, {
        actorId: author,
        forumId: forum,
        title: "Stale webhook topic",
        bodyMd: "Safe topic body.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      await database.sql`
        UPDATE core.posts
        SET body_html = '<p>Safe</p><img src=x onerror="alert(1)">',
            render_version = 1,
            sanitiser_version = 1
        WHERE id = ${created.result.postId}
      `;
      const event = await loadEvent(database.sql, await latestEvent(database, "topic.created"));

      if (event === null) {
        throw new Error("Missing event");
      }

      const payload = await buildWebhookPayload(database.sql, webhook, event);
      const html = (payload?.content as { readonly bodyHtml?: string } | undefined)?.bodyHtml;
      expect(html).toContain("Safe");
      expect(html).not.toContain("onerror");
    });
  }, 30_000);

  test("keeps a failing event's deadline when another delivery succeeds", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const principal = await servicePrincipal(database, "Deadline Bot");
      const { webhook, secret } = await createWebhook(database, principal, ["post.created"]);
      const topic = await startTopic(database.sql, {
        actorId: admin,
        forumId: forum,
        title: "Deadline topic",
        bodyMd: "Topic body.",
      });

      if (!topic.ok) {
        throw new Error("Could not create the topic");
      }

      for (const bodyMd of ["First reply.", "Second reply."]) {
        const replied = await reply(database.sql, {
          actorId: author,
          topicId: topic.result.topicId,
          bodyMd,
        });

        if (!replied.ok) {
          throw new Error("Could not create the reply");
        }
      }

      const events = (await database.sql`
        SELECT id::text AS id FROM core.events
        WHERE type = 'post.created' ORDER BY id DESC LIMIT 2
      `) as Array<{ id: string }>;
      const successEvent = events[0]?.id;
      const failingEvent = events[1]?.id;

      if (successEvent === undefined || failingEvent === undefined) {
        throw new Error("Missing events");
      }

      const started = new Date("2026-01-01T00:00:00.000Z");
      const deadline = new Date(started.getTime() + WEBHOOK_FAILURE_WINDOW_MS);
      const first = await createWebhookDelivery(database.sql, {
        webhookId: webhook.id,
        eventId: failingEvent,
        attempt: 1,
        retryDeadline: deadline,
      });
      const other = await createWebhookDelivery(database.sql, {
        webhookId: webhook.id,
        eventId: successEvent,
        attempt: 1,
        retryDeadline: deadline,
      });

      if (first === null || other === null) {
        throw new Error("Could not create deliveries");
      }

      const failed = await attemptWebhookDelivery(database.sql, first, {
        fetch: failingFetch(),
        now: started,
      });
      expect(failed?.retryAt?.getTime()).toBe(started.getTime() + 30_000);

      const [secondAttempt] = (await database.sql`
        SELECT id::text AS id, retry_deadline
        FROM core.webhook_deliveries
        WHERE webhook_id = ${webhook.id} AND event_id = ${failingEvent} AND attempt = 2
      `) as Array<{ id: string; retry_deadline: Date }>;
      expect(secondAttempt?.retry_deadline.toISOString()).toBe(deadline.toISOString());

      const mock = mockFetch(secret);
      const succeeded = await attemptWebhookDelivery(database.sql, other, {
        fetch: mock.fetch,
        now: new Date(started.getTime() + 60 * 60 * 1_000),
      });
      expect(succeeded?.status).toBe("delivered");
      expect((await readWebhook(database.sql, webhook.id))?.failureSince).toBeNull();

      const nearDeadline = new Date(deadline.getTime() - 10_000);
      const retried = await attemptWebhookDelivery(database.sql, secondAttempt?.id ?? "", {
        fetch: failingFetch(),
        now: nearDeadline,
      });
      expect(retried?.retryAt?.toISOString()).toBe(deadline.toISOString());

      const [thirdAttempt] = (await database.sql`
        SELECT id::text AS id, retry_deadline
        FROM core.webhook_deliveries
        WHERE webhook_id = ${webhook.id} AND event_id = ${failingEvent} AND attempt = 3
      `) as Array<{ id: string; retry_deadline: Date }>;
      expect(thirdAttempt?.retry_deadline.toISOString()).toBe(deadline.toISOString());

      const exhausted = await attemptWebhookDelivery(database.sql, thirdAttempt?.id ?? "", {
        fetch: failingFetch(),
        now: deadline,
      });
      expect(exhausted?.retryAt).toBeNull();
      expect(exhausted?.disabled).toBe(false);
      expect((await readWebhook(database.sql, webhook.id))?.enabled).toBe(true);

      const [attempts] = (await database.sql`
        SELECT count(*)::int AS count FROM core.webhook_deliveries
        WHERE webhook_id = ${webhook.id} AND event_id = ${failingEvent}
      `) as Array<{ count: number }>;
      expect(attempts?.count).toBe(3);
    });
  }, 30_000);

  test("an independent sweep disables a delayed first failure after 24 hours", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const principal = await servicePrincipal(database, "Delayed Bot");
      const { webhook } = await createWebhook(database, principal, ["post.created"]);
      await createPublicTopicAndReply(database, forum, author, "Delayed failure topic");
      const eventId = await latestEvent(database, "post.created");
      const created = new Date("2026-01-01T00:00:00.000Z");
      const firstAttempt = new Date(created.getTime() + 23 * 60 * 60 * 1_000);
      const deliveryId = await createWebhookDelivery(database.sql, {
        webhookId: webhook.id,
        eventId: eventId.toString(),
        attempt: 1,
        retryDeadline: new Date(created.getTime() + WEBHOOK_FAILURE_WINDOW_MS),
      });

      if (deliveryId === null) {
        throw new Error("Could not create the delayed delivery");
      }

      const failed = await attemptWebhookDelivery(database.sql, deliveryId, {
        fetch: failingFetch(),
        now: firstAttempt,
      });
      expect(failed?.status).toBe("failed");
      expect((await readWebhook(database.sql, webhook.id))?.enabled).toBe(true);

      // No manual failure_since backdating: the first attempt itself happened 23 hours late,
      // so the first sweep only crosses the continuous-failure threshold at +47 hours.
      const before = await disableExpiredWebhooks(
        database.sql,
        new Date(firstAttempt.getTime() + 60 * 60 * 1_000),
      );
      expect(before).toBe(0);

      const after = await disableExpiredWebhooks(
        database.sql,
        new Date(firstAttempt.getTime() + WEBHOOK_FAILURE_WINDOW_MS + 1_000),
      );
      expect(after).toBe(1);
      const disabled = await readWebhook(database.sql, webhook.id);
      expect(disabled?.enabled).toBe(false);
      expect(disabled?.disabledReason).toBe("continuous_failure");

      const [notification] = (await database.sql`
        SELECT count(*)::int AS count FROM core.notifications
        WHERE member_id = ${admin} AND type = 'webhook.disabled' AND event_id IS NULL
      `) as Array<{ count: number }>;
      expect(notification?.count).toBe(1);
    });
  }, 30_000);

  test("logs retries, redelivers with a fresh signature and auto-disables after 24 hours", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const principal = await servicePrincipal(database, "Retry Bot");
      const { webhook, secret } = await createWebhook(database, principal, ["post.created"]);
      const content = await createPublicTopicAndReply(database, forum, author, "Retry topic");
      const eventId = await latestEvent(database, "post.created");
      const first = await createWebhookDelivery(database.sql, {
        webhookId: webhook.id,
        eventId: eventId.toString(),
        attempt: 1,
      });

      if (first === null) {
        throw new Error("Could not create the first delivery");
      }

      const started = new Date("2026-01-01T00:00:00.000Z");
      const failed = await attemptWebhookDelivery(database.sql, first, {
        fetch: failingFetch(),
        now: started,
      });
      expect(failed?.status).toBe("failed");
      expect(failed?.retryAt?.getTime()).toBe(started.getTime() + 30_000);

      const stored = await readWebhook(database.sql, webhook.id);
      expect(stored?.failureSince?.toISOString()).toBe(started.toISOString());

      const log = await listWebhookDeliveries(database.sql, { webhookId: webhook.id });
      expect(log.find((entry) => entry.attempt === 1)).toMatchObject({
        status: "failed",
        httpStatus: 500,
        attempt: 1,
      });

      // The failure and its successor retry were committed together; an interrupted worker
      // leaves this row waiting for the sweep at its deadline.
      const [successor] = (await database.sql`
        SELECT id::text AS id, attempt, status, enqueued_at, scheduled_at
        FROM core.webhook_deliveries
        WHERE webhook_id = ${webhook.id} AND event_id = ${eventId.toString()} AND attempt = 2
      `) as Array<{
        id: string;
        attempt: number;
        status: string;
        enqueued_at: Date | null;
        scheduled_at: Date;
      }>;
      expect(successor).toMatchObject({ attempt: 2, status: "pending", enqueued_at: null });
      expect(successor?.scheduled_at.toISOString()).toBe(failed.retryAt?.toISOString());

      const tooEarly = await pendingWebhookDeliveries(database.sql, 100, started);
      expect(tooEarly.map((entry) => entry.id)).not.toContain(successor?.id);
      const due = await pendingWebhookDeliveries(database.sql, 100, failed.retryAt ?? started);
      expect(due.map((entry) => entry.id)).toContain(successor?.id);

      const redeliveryResponse = await mutateWebhookForStaff(
        database.sql,
        admin,
        new Request("http://staff.bulletin.localhost/api/staff/webhooks", {
          method: "POST",
          body: JSON.stringify({ action: "redeliver", deliveryId: first }),
        }),
      );
      expect(redeliveryResponse.status).toBe(200);
      const redelivered = (await redeliveryResponse.json()) as { deliveryId: string };
      const redelivery = redelivered.deliveryId;

      const mock = mockFetch(secret);
      const later = new Date(started.getTime() + 60_000);
      const delivered = await attemptWebhookDelivery(database.sql, redelivery, {
        fetch: mock.fetch,
        now: later,
      });
      expect(delivered?.status).toBe("delivered");
      expect(mock.store.list()[0]?.signatureValid).toBe(true);
      expect(mock.store.list()[0]?.headers["x-bulletin-timestamp"]).toBe(
        String(Math.floor(later.getTime() / 1_000)),
      );
      expect(content.postId).toMatch(/^\d+$/);

      const afterSuccess = await readWebhook(database.sql, webhook.id);
      expect(afterSuccess?.failureSince).toBeNull();

      // Move the failure window back so the next failure crosses 24 hours and disables it.
      await database.sql`
        UPDATE core.webhooks
        SET failure_since = ${new Date(started.getTime() - WEBHOOK_FAILURE_WINDOW_MS)}
        WHERE id = ${webhook.id}
      `;
      const finalAttempt = await nextWebhookAttempt(database.sql, webhook.id, eventId.toString());
      const finalDelivery = await createWebhookDelivery(database.sql, {
        webhookId: webhook.id,
        eventId: eventId.toString(),
        attempt: finalAttempt,
      });

      if (finalDelivery === null) {
        throw new Error("Could not create the final delivery");
      }

      const disabled = await attemptWebhookDelivery(database.sql, finalDelivery, {
        fetch: failingFetch(),
        now: later,
      });
      expect(disabled?.disabled).toBe(true);

      const disabledWebhook = await readWebhook(database.sql, webhook.id);
      expect(disabledWebhook?.enabled).toBe(false);
      expect(disabledWebhook?.disabledReason).toBe("continuous_failure");

      const [notification] = (await database.sql`
        SELECT count(*)::int AS count
        FROM core.notifications
        WHERE member_id = ${admin} AND type = 'webhook.disabled'
      `) as Array<{ count: number }>;
      expect(notification?.count).toBe(1);
    });
  }, 30_000);
});

describe("webhook mock", () => {
  test("verifies the shared secret signature format", async () => {
    const store = createWebhookStore();
    const handler = createWebhookHandler(store, MOCK_SECRET);
    const body = JSON.stringify({ hello: "world" });
    const timestamp = "1767225600";
    const signature = createHmac("sha256", MOCK_SECRET)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    const response = await handler(
      new Request("http://webhooks/hook", {
        method: "POST",
        headers: {
          "x-bulletin-timestamp": timestamp,
          "x-bulletin-signature": `sha256=${signature}`,
        },
        body,
      }),
    );

    expect(response.status).toBe(202);
    expect(store.list()[0]?.signatureValid).toBe(true);
  });
});
