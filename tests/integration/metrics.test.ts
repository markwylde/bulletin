import { describe, expect, test } from "bun:test";
import { createRenderCache } from "@bulletin/cache";
import {
  exposedFamilies,
  METRIC_FAMILIES,
  parsePrometheusText,
  standardMetrics,
} from "@bulletin/config/metrics";
import { startService } from "@bulletin/config/server";
import { createPgBossQueue, registerQueueCollector } from "@bulletin/db/events";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "metrics" }, run);
}

function roleUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

integrationDescribe("metrics endpoint (ADR 0020)", () => {
  test("a scrape returns each listed metric family with live values", async () => {
    await withDb(async (database) => {
      const workersSql = new SQL(roleUrl(database.url, "workers"), { max: 2 });
      const boss = await createPgBossQueue({
        connectionString: roleUrl(database.url, "workers"),
        schema: "pgboss",
        supervise: false,
        schedule: false,
      });
      const unregister = registerQueueCollector(workersSql);
      const service = await startService({
        service: "metrics-test",
        hostname: "127.0.0.1",
        port: 0,
        metricsPort: 0,
        installSignalHandlers: false,
        budget: { sql: workersSql, service: "workers" },
        fetch: () => new Response("ok"),
      });

      try {
        // A job that has waited a minute and an outbox event that was never published.
        await boss.boss.send("domain-events", { eventId: "1", subscriber: "core" });
        await database.sql`
          UPDATE pgboss.job SET start_after = now() - interval '60 seconds'
          WHERE name = 'domain-events'
        `;
        await database.sql`
          INSERT INTO core.events (type, aggregate_type, aggregate_id, aggregate_version,
                                   payload_ids, created_at)
          VALUES ('topic.created', 'topic', 1, 1, '{"topicId":"1","forumId":"1"}'::jsonb,
                  now() - interval '10 seconds')
        `;

        // A request, a cached render, an SSE stream and a plugin hook call.
        const base = `http://127.0.0.1:${service.server.port}`;
        expect((await fetch(`${base}/topic/12-hello`)).status).toBe(200);
        const cache = createRenderCache({ tags: { version: () => "1", isTrusted: () => true } });
        await cache.getOrRender({
          tags: ["topic:1"],
          prepare: async () => ({ key: "route=%2Fmetrics-test&params=", data: undefined }),
          render: () => "<p>x</p>",
        });
        standardMetrics.sseConnections.inc();
        standardMetrics.pluginHookDuration.observe(
          { plugin: "demo", hook: "post.render", outcome: "ok" },
          0.01,
        );

        const scrape = await fetch(`http://127.0.0.1:${service.metricsServer?.port}/metrics`);
        expect(scrape.status).toBe(200);
        const text = await scrape.text();
        const families = exposedFamilies(text);

        for (const family of Object.values(METRIC_FAMILIES)) {
          expect(families.has(family)).toBe(true);
        }

        const samples = parsePrometheusText(text);
        const value = (name: string, labels: Record<string, string> = {}) =>
          samples.find(
            (sample) =>
              sample.name === name &&
              Object.entries(labels).every(([key, expected]) => sample.labels[key] === expected),
          )?.value;

        expect(value(`${METRIC_FAMILIES.requestDuration}_count`, { route: "/topic/:id" })).toBe(1);
        expect(value(METRIC_FAMILIES.queueDepth, { queue: "domain-events" })).toBe(1);
        expect(value(METRIC_FAMILIES.queueLag, { queue: "domain-events" })).toBeGreaterThan(50);
        expect(value(METRIC_FAMILIES.outboxLag)).toBeGreaterThan(5);
        expect(value(METRIC_FAMILIES.cacheVariants, { route: "/metrics-test" })).toBe(1);
        expect(value(METRIC_FAMILIES.dbPoolMax)).toBe(5);
        expect(value(METRIC_FAMILIES.dbPoolConnections, { state: "idle" })).toBeGreaterThanOrEqual(
          0,
        );
        expect(value(METRIC_FAMILIES.sseConnections)).toBeGreaterThanOrEqual(1);
      } finally {
        standardMetrics.sseConnections.dec();
        unregister();
        await service.shutdown();
        await boss.stop();
        await workersSql.close();
      }
    });
  }, 60_000);
});
