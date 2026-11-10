import { describe, expect, test } from "bun:test";
import {
  createMaintenanceJobs,
  MAINTENANCE_CRON,
  MAINTENANCE_QUEUE,
  runMaintenance,
} from "@bulletin/db/jobs";
import { baseSeedModule, runSeeds, SeedRegistry } from "@bulletin/db/seed";
import { forwardSystemAudits, queueSystemAudit } from "@bulletin/domain/audit";
import { recordVisit, VISIT_BUFFER_RETENTION_MS } from "@bulletin/domain/visits";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
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
      const expired = new Date(now.getTime() - VISIT_BUFFER_RETENTION_MS - 60_000);

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
