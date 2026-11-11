import { describe, expect, test } from "bun:test";
import {
  createMaintenanceJobs,
  MAINTENANCE_CRON,
  MAINTENANCE_QUEUE,
  runMaintenance,
} from "@bulletin/db/jobs";
import { baseSeedModule, runSeeds, SeedRegistry } from "@bulletin/db/seed";
import { forwardSystemAudits, queueSystemAudit } from "@bulletin/domain/audit";
import { expireVisitBuffers, recordVisit } from "@bulletin/domain/visits";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import type { PgBoss } from "pg-boss";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "maintenance" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([baseSeedModule]),
    });
    await run(database);
  });
}

integrationDescribe("maintenance sweep (ADR 0012)", () => {
  test("forwards queued audit events and expires old visit buffers", async () => {
    await withDb(async (database) => {
      const now = new Date();
      // Older than the half-hour view bucket as well as the presence retention.
      const expired = new Date(now.getTime() - 60 * 60_000);

      await recordVisit(database.sql, { viewerKey: "guest:old", ctx: "topic:401", now: expired });
      await recordVisit(database.sql, { viewerKey: "guest:fresh", ctx: "topic:402", now });
      await queueSystemAudit(database.sql, {
        action: "theme.render.error",
        targetType: "theme_template",
        summary: { template: "demo", message: "invalid props" },
      });

      const result = await runMaintenance(database.sql);

      expect(result).toEqual({
        forwardedAudits: 1,
        expiredPresence: 1,
        expiredViews: 1,
        expiredDrafts: 0,
        flushedTopicViews: 2,
        expiredTopicStubs: 0,
        closedPolls: 0,
      });

      const log = (await database.sql`
        SELECT action, summary FROM core.admin_log ORDER BY id
      `) as Array<{ action: string; summary: unknown }>;
      const queued = (await database.sql`
        SELECT count(*)::int AS count FROM core.system_audit_buffer
      `) as Array<{ count: number }>;
      const presence = (await database.sql`
        SELECT viewer_key FROM core.presence ORDER BY viewer_key
      `) as Array<{ viewer_key: string }>;

      expect(log).toHaveLength(1);
      expect(log[0]?.action).toBe("theme.render.error");
      expect(JSON.stringify(log[0]?.summary)).toContain("invalid props");
      expect(queued[0]?.count).toBe(0);
      expect(presence.map((row) => row.viewer_key)).toEqual(["guest:fresh"]);
    });
  });

  test("runs as the worker role and can flush views and expire stubs", async () => {
    await withDb(async (database) => {
      const [member] = (await database.sql`
        INSERT INTO core.members (display_name) VALUES ('Maintenance Worker') RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [forum] = (await database.sql`
        INSERT INTO core.forums (type, title, slug) VALUES ('forum', 'Worker Forum', 'worker-forum')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (member === undefined || forum === undefined) {
        throw new Error("Could not create maintenance fixtures");
      }

      const [topic] = (await database.sql`
        INSERT INTO core.topics (forum_id, title, slug, starter_id)
        VALUES (${forum.id}, 'Worker topic', 'worker-topic', ${member.id})
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (topic === undefined) {
        throw new Error("Could not create the worker topic");
      }

      await database.sql`
        INSERT INTO core.topic_view_buffer (topic_id, viewer_key, bucket)
        VALUES (${topic.id}, 'guest:maintenance', now())
      `;
      await database.sql`
        INSERT INTO core.topics (
          forum_id, title, slug, starter_id, locked, moved_to, stub_expires_at
        )
        VALUES (
          ${forum.id}, 'Expired stub', 'expired-stub', ${member.id}, true,
          ${topic.id}, now() - interval '1 minute'
        )
      `;

      const url = new URL(database.url);
      url.username = "workers";
      url.password = "";
      const worker = new SQL(url.toString());

      try {
        const result = await runMaintenance(worker);
        expect(result.flushedTopicViews).toBe(1);
        expect(result.expiredTopicStubs).toBe(1);
      } finally {
        await worker.close();
      }

      const [view] = (await database.sql`
        SELECT view_count FROM core.topics WHERE id = ${topic.id}
      `) as Array<{ view_count: string }>;
      expect(view?.view_count).toBe("1");
    });
  }, 30_000);

  test("counts a view that closes its bucket at the half-hour boundary", async () => {
    await withDb(async (database) => {
      const [member] = (await database.sql`
        INSERT INTO core.members (display_name) VALUES ('Boundary Member') RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [forum] = (await database.sql`
        INSERT INTO core.forums (type, title, slug) VALUES ('forum', 'Boundary Forum', 'boundary-forum')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (member === undefined || forum === undefined) {
        throw new Error("Could not create maintenance fixtures");
      }

      const [topic] = (await database.sql`
        INSERT INTO core.topics (forum_id, title, slug, starter_id)
        VALUES (${forum.id}, 'Boundary topic', 'boundary-topic', ${member.id})
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (topic === undefined) {
        throw new Error("Could not create the boundary topic");
      }

      // A view at 12:29:59 belongs to the 12:00 bucket; the sweep runs at 12:30.
      await database.sql`
        INSERT INTO core.topic_view_buffer (topic_id, viewer_key, bucket)
        VALUES (${topic.id}, 'guest:boundary', '2026-11-10T12:00:00Z')
      `;

      const result = await runMaintenance(database.sql, {
        now: new Date("2026-11-10T12:30:00Z"),
      });

      expect(result.flushedTopicViews).toBe(1);
      expect(result.expiredViews).toBe(1);

      const [view] = (await database.sql`
        SELECT view_count FROM core.topics WHERE id = ${topic.id}
      `) as Array<{ view_count: string }>;
      expect(view?.view_count).toBe("1");

      const [buffer] = (await database.sql`
        SELECT count(*)::int AS count FROM core.topic_view_buffer
      `) as Array<{ count: number }>;
      expect(buffer?.count).toBe(0);

      // Expiry on its own never drops a row the flush has not counted.
      await database.sql`
        INSERT INTO core.topic_view_buffer (topic_id, viewer_key, bucket)
        VALUES (${topic.id}, 'guest:uncounted', '2026-11-10T12:00:00Z')
      `;
      expect(
        await expireVisitBuffers(database.sql, { now: new Date("2026-11-10T12:31:00Z") }),
      ).toEqual({ presence: 0, views: 0 });
    });
  }, 30_000);

  test("registers the sweep on the every-minute pg-boss schedule", async () => {
    await withDb(async (database) => {
      const calls: string[] = [];
      let handler: (() => Promise<void>) | null = null;

      const boss = {
        getQueue: async () => ({}),
        updateQueue: async (name: string) => {
          calls.push(`update:${name}`);
        },
        createQueue: async (name: string) => {
          calls.push(`create:${name}`);
        },
        work: async (name: string, work: () => Promise<void>) => {
          calls.push(`work:${name}`);
          handler = work;
        },
        schedule: async (name: string, cron: string) => {
          calls.push(`schedule:${name}:${cron}`);
        },
        offWork: async (name: string) => {
          calls.push(`off:${name}`);
        },
      } as unknown as PgBoss;

      const jobs = await createMaintenanceJobs({ boss, sql: database.sql });

      expect(calls).toContain(`work:${MAINTENANCE_QUEUE}`);
      expect(calls).toContain(`schedule:${MAINTENANCE_QUEUE}:${MAINTENANCE_CRON}`);
      expect(MAINTENANCE_CRON).toBe("* * * * *");

      await queueSystemAudit(database.sql, {
        action: "theme.compile",
        targetType: "theme_template",
        summary: { template: "demo" },
      });

      if (handler === null) {
        throw new Error("maintenance handler was not registered");
      }

      await handler();

      expect((await forwardSystemAudits(database.sql)).forwarded).toBe(0);
      expect(
        (
          (await database.sql`SELECT count(*)::int AS count FROM core.admin_log`) as Array<{
            count: number;
          }>
        )[0]?.count,
      ).toBe(1);

      await jobs.stop();
      expect(calls).toContain(`off:${MAINTENANCE_QUEUE}`);
    });
  });
});
