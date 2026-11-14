import { describe, expect, test } from "bun:test";
import { createPgBossQueue } from "@bulletin/db/events";
import {
  baseSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import type { SessionRecord } from "@bulletin/domain/auth";
import { displayNameSkeleton } from "@bulletin/domain/member";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import {
  authorizeStaffRoute,
  STAFF_ROUTES,
  type StaffRoute,
  type StaffRouteContext,
} from "../../apps/staff-api/src/api.ts";
import {
  type HealthTarget,
  healthTargetsFromEnv,
  type SystemHealthReport,
} from "../../apps/staff-api/src/system-health.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function roleUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function createMember(
  database: TestDatabase,
  name: string,
  groups: readonly string[],
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${displayNameSkeleton(name)})
    RETURNING id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  for (const [index, key] of groups.entries()) {
    await database.sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      SELECT ${member.id}, g.id, ${index === 0}
      FROM core.groups g
      WHERE g.key = ${key}
    `;
  }

  return member.id;
}

const healthRoute = STAFF_ROUTES.find((route) => route.id === "system.health") as StaffRoute;

function context(sql: SQL, memberId: string, targets: readonly HealthTarget[]): StaffRouteContext {
  const url = new URL("http://staff.test/api/staff/system/health");

  return {
    request: new Request(url),
    url,
    session: { id: "1", memberId, lastAuthAt: new Date() } as unknown as SessionRecord,
    sql,
    checks: [{ name: "database", check: () => true }],
    healthTargets: targets,
  };
}

/** A stand-in service on the internal network: readiness plus a metrics snapshot. */
function fakeService(options: { readonly ready: boolean; readonly metrics: string }) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname === "/health/ready") {
        return Response.json(
          { status: options.ready ? "ok" : "unavailable", checks: { database: options.ready } },
          { status: options.ready ? 200 : 503 },
        );
      }

      return pathname === "/metrics"
        ? new Response(options.metrics)
        : new Response("not found", { status: 404 });
    },
  });
}

describe("health targets", () => {
  test("parses health targets from the environment", () => {
    expect(
      healthTargetsFromEnv({
        BULLETIN_HEALTH_TARGETS:
          "user-api=http://user-api:3001,workers=http://workers:3003|off,bad",
      }),
    ).toEqual([
      {
        name: "user-api",
        url: "http://user-api:3001",
        metricsUrl: "http://user-api:9464/metrics",
      },
      { name: "workers", url: "http://workers:3003", metricsUrl: null },
    ]);
  });
});

integrationDescribe("staff system health panel", () => {
  test("reports readiness, lagging queues and metrics to acp.system only", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "system_health" }, async (database) => {
      await runSeeds({
        sql: database.sql,
        registry: new SeedRegistry([
          baseSeedModule,
          permissionFixtureSeedModule,
          groupsSeedModule,
          membersSeedModule,
        ]),
      });

      const staffSql = new SQL(roleUrl(database.url, "staff_api"));
      const boss = await createPgBossQueue({
        connectionString: roleUrl(database.url, "workers"),
        schema: "pgboss",
        supervise: false,
        schedule: false,
      });
      const userApp = fakeService({
        ready: true,
        metrics: [
          'bulletin_cache_requests_total{route="/",result="hit"} 90',
          'bulletin_cache_requests_total{route="/",result="miss"} 9',
          'bulletin_cache_requests_total{route="/",result="bypass"} 1',
          'bulletin_cache_bypass_seconds_total{route="/"} 0.25',
          "bulletin_cache_untrusted_seconds_total 4",
          'bulletin_cache_variants{route="/"} 3',
          'bulletin_cache_variants{route="/topic/[id]"} 120',
          'bulletin_db_pool_connections{state="active"} 8',
          'bulletin_db_pool_connections{state="idle"} 2',
          "bulletin_db_pool_max 10",
          "bulletin_sse_connections 0",
        ].join("\n"),
      });
      const workers = fakeService({ ready: false, metrics: "" });
      const targets: HealthTarget[] = [
        {
          name: "user-app",
          url: `http://127.0.0.1:${userApp.port}`,
          metricsUrl: `http://127.0.0.1:${userApp.port}/metrics`,
        },
        { name: "workers", url: `http://127.0.0.1:${workers.port}`, metricsUrl: null },
        // Nothing listens here: the service is reported as unreachable, not as an error.
        { name: "plugin-host", url: "http://127.0.0.1:9", metricsUrl: null },
      ];

      try {
        await boss.boss.createQueue("health-slow");
        await boss.boss.createQueue("health-fast");
        await boss.boss.send("health-slow", { id: "1" });
        await boss.boss.send("health-fast", { id: "2" });
        await database.sql`
          UPDATE pgboss.job SET start_after = now() - interval '45 seconds'
          WHERE name = 'health-slow'
        `;

        const admin = await createMember(database, "Health Admin", ["administrators"]);
        const allowed = await authorizeStaffRoute(healthRoute, context(staffSql, admin, targets));
        expect(allowed.status).toBe(200);
        const report = (await allowed.json()) as SystemHealthReport;

        expect(report.status).toBe("degraded");
        expect(report.services.map((service) => [service.name, service.ready])).toEqual([
          ["staff-api", true],
          ["user-app", true],
          ["workers", false],
          ["plugin-host", false],
        ]);
        expect(report.services.find((service) => service.name === "plugin-host")?.reachable).toBe(
          false,
        );

        const slow = report.queues.find((queue) => queue.queue === "health-slow");
        const fast = report.queues.find((queue) => queue.queue === "health-fast");
        expect(slow?.lagging).toBe(true);
        expect(slow?.lagSeconds).toBeGreaterThan(30);
        expect(fast?.lagging).toBe(false);
        expect(report.queueLagWarningSeconds).toBe(30);

        expect(report.cache.hits).toBe(90);
        expect(report.cache.hitRate).toBe(0.9);
        expect(report.cache.bypassSeconds).toBe(0.25);
        expect(report.cache.untrustedSeconds).toBe(4);
        expect(report.variants[0]).toEqual({
          route: "/topic/[id]",
          variants: 120,
          overBudget: true,
        });
        expect(report.variants.find((variant) => variant.route === "/")?.overBudget).toBe(false);
        expect(report.pools.find((pool) => pool.service === "user-app")).toEqual({
          service: "user-app",
          inUse: 8,
          open: 10,
          max: 10,
          saturation: 0.8,
        });
        expect(Array.isArray(report.plugins)).toBe(true);

        // Permission denial: a super moderator has ACP access but not acp.system, and an
        // ordinary member has no ACP access at all.
        const moderator = await createMember(database, "Health Moderator", [
          "members",
          "super_moderators",
        ]);
        const member = await createMember(database, "Health Member", ["members"]);

        for (const denied of [moderator, member]) {
          const response = await authorizeStaffRoute(
            healthRoute,
            context(staffSql, denied, targets),
          );
          expect(response.status).toBe(403);
        }
      } finally {
        userApp.stop(true);
        workers.stop(true);
        await boss.stop();
        await staffSql.close();
      }
    });
  }, 60_000);
});
