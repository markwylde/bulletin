import { describe, expect, test } from "bun:test";
import { startService } from "@bulletin/config/server";
import {
  type FinishedSpan,
  InMemorySpanExporter,
  initTracing,
  SpanKind,
} from "@bulletin/config/tracing";
import { createEventWorker, createPgBossQueue, createRelay } from "@bulletin/db/events";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  reactionsSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { reply, startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { createNotificationsEventHandler } from "../../apps/workers/src/notifications.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function roleUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function one(database: TestDatabase, query: Promise<unknown>): Promise<string> {
  const [row] = (await query) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing seed row in ${database.name}`);
  }

  return row.id;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const value = read();

    if (value !== undefined) {
      return value;
    }

    await Bun.sleep(50);
  }

  throw new Error("Timed out waiting for the span");
}

function only(spans: readonly FinishedSpan[], predicate: (span: FinishedSpan) => boolean) {
  const matches = spans.filter(predicate);
  expect(matches).toHaveLength(1);
  return matches[0] as FinishedSpan;
}

integrationDescribe("distributed tracing (ADR 0020)", () => {
  test("a reply produces one trace from request to notification job", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "tracing" }, async (database) => {
      await runSeeds({
        sql: database.sql,
        registry: new SeedRegistry([
          baseSeedModule,
          flagsSeedModule,
          permissionFixtureSeedModule,
          reactionsSeedModule,
          groupsSeedModule,
          forumExtrasSeedModule,
          membersSeedModule,
        ]),
      });

      const forumId = await one(
        database,
        database.sql`SELECT id::text AS id FROM core.forums WHERE slug = 'off-topic'`,
      );
      const starter = await one(
        database,
        database.sql`SELECT member_id::text AS id FROM pii.identities WHERE sub = 'member-1'`,
      );
      const replier = await one(
        database,
        database.sql`SELECT member_id::text AS id FROM pii.identities WHERE sub = 'member-2'`,
      );
      const topic = await startTopic(database.sql, {
        actorId: starter,
        forumId,
        title: "A traced topic",
        bodyMd: "The first post of a traced topic.",
      });

      if (!topic.ok) {
        throw new Error(`startTopic failed: ${topic.code}`);
      }

      // Earlier events are not part of the reply's trace.
      await database.sql`UPDATE core.events SET published_at = now()`;

      const exporter = new InMemorySpanExporter();
      initTracing({ service: "tracing-test", exporter });
      const service = await startService({
        service: "user-api",
        hostname: "127.0.0.1",
        port: 0,
        installSignalHandlers: false,
        async fetch() {
          const created = await reply(database.sql, {
            actorId: replier,
            topicId: topic.result.topicId,
            bodyMd: "A reply that should be traced end to end.",
          });
          return Response.json({ ok: created.ok });
        },
      });
      const boss = await createPgBossQueue({
        connectionString: roleUrl(database.url, "workers"),
        schema: "pgboss",
        supervise: false,
        schedule: false,
      });
      const worker = await createEventWorker({
        boss: boss.boss,
        sql: database.sql,
        handlers: { notifications: createNotificationsEventHandler({ sql: database.sql }) },
      });

      try {
        const response = await fetch(
          `http://127.0.0.1:${service.server.port}/api/topics/${topic.result.topicId}/replies`,
          { method: "POST" },
        );
        expect(await response.json()).toEqual({ ok: true });

        const relay = createRelay({
          sql: database.sql,
          subscribers: [{ name: "notifications", types: ["post.created"] }],
          queue: boss.queue,
        });
        expect((await relay.runOnce()).published).toBe(1);

        const job = await waitFor(() =>
          exporter.spans.find((span) => span.name === "job domain-events notifications"),
        );
        const spans = exporter.spans;
        const request = only(spans, (span) => span.kind === SpanKind.SERVER);
        const transaction = only(spans, (span) => span.name.startsWith("db.transaction "));
        const relaySpan = only(spans, (span) => span.name === "outbox.relay post.created");

        // One trace: request → database transaction → event relay → notification job.
        expect(
          new Set([request, transaction, relaySpan, job].map((span) => span.traceId)).size,
        ).toBe(1);
        expect(request.parentSpanId).toBeNull();
        expect(transaction.parentSpanId).toBe(request.spanId);
        expect(relaySpan.parentSpanId).toBe(transaction.spanId);
        expect(job.parentSpanId).toBe(relaySpan.spanId);
        expect(job.kind).toBe(SpanKind.CONSUMER);
        expect(transaction.attributes["db.system"]).toBe("postgresql");

        const [notification] = (await database.sql`
          SELECT member_id::text AS member_id FROM core.notifications WHERE type = 'topic.reply'
        `) as Array<{ member_id: string }>;
        expect(notification?.member_id).toBe(starter);

        // The outbox row carries the trace context, never content.
        const [event] = (await database.sql`
          SELECT trace_parent FROM core.events WHERE type = 'post.created'
          ORDER BY id DESC LIMIT 1
        `) as Array<{ trace_parent: string }>;
        expect(event?.trace_parent).toBe(`00-${transaction.traceId}-${transaction.spanId}-01`);
      } finally {
        initTracing({ service: "tracing-test", exporter: null });
        await worker.stop();
        await boss.stop();
        await service.shutdown();
      }
    });
  }, 60_000);
});
