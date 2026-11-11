import { describe, expect, test } from "bun:test";
import { createPgBossQueue, listDeadLetters, retryDeadLetter } from "@bulletin/db/events";
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

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, run);
}

function roleUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function waitForState(sql: SQL, id: string, state: string, attempts = 200): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const [row] = (await sql`
      SELECT state FROM pgboss.job WHERE id = ${id}
    `) as Array<{ state: string }>;

    if (row?.state === state) {
      return state;
    }

    await Bun.sleep(50);
  }

  throw new Error(`Job ${id} never reached ${state}`);
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

function route(id: string): StaffRoute {
  const found = STAFF_ROUTES.find((candidate) => candidate.id === id);

  if (found === undefined) {
    throw new Error(`No route ${id}`);
  }

  return found;
}

function staffContext(options: {
  readonly sql: SQL;
  readonly memberId: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}): StaffRouteContext {
  const session = {
    id: "1",
    memberId: options.memberId,
    lastAuthAt: new Date(),
  } as unknown as SessionRecord;

  return {
    request: new Request(`http://staff.test${options.path}`, {
      method: options.method ?? "GET",
      ...(options.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(options.body),
          }),
    }),
    url: new URL(`http://staff.test${options.path}`),
    session,
    sql: options.sql,
    checks: [],
  };
}

integrationDescribe("dead letters", () => {
  test("staff list a failed delivery and retry it", async () => {
    await withDb("dead_letters", async (database) => {
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

      try {
        await boss.boss.updateQueue("domain-events", { retryLimit: 1, retryDelay: 0 });

        let failing = true;
        let handled = 0;
        await boss.boss.work("domain-events", async () => {
          handled += 1;

          if (failing) {
            throw new Error("notification handler failed");
          }
        });

        const jobId = await boss.boss.send("domain-events", {
          eventId: "7",
          subscriber: "notifications",
        });

        if (jobId === null) {
          throw new Error("Could not enqueue the job");
        }

        await waitForState(database.sql, jobId, "failed");

        const page = await listDeadLetters(staffSql, { limit: 10 });
        expect(page.total).toBe(1);
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0]).toMatchObject({
          id: jobId,
          queue: "domain-events",
          payload: { eventId: "7", subscriber: "notifications" },
          attempts: 2,
        });
        expect(page.entries[0]?.error).toContain("notification handler failed");
        expect(page.entries[0]?.failedAt).not.toBeNull();

        // A member without acp.system cannot read or retry dead letters.
        const moderator = await createMember(database, "Dead Letter Moderator", [
          "members",
          "super_moderators",
        ]);
        const deniedList = await authorizeStaffRoute(
          route("events.deadLetters.list"),
          staffContext({
            sql: staffSql,
            memberId: moderator,
            path: "/api/staff/events/dead-letters",
          }),
        );
        expect(deniedList.status).toBe(403);

        const deniedRetry = await authorizeStaffRoute(
          route("events.deadLetters.retry"),
          staffContext({
            sql: staffSql,
            memberId: moderator,
            path: "/api/staff/events/dead-letters",
            method: "POST",
            body: { id: jobId },
          }),
        );
        expect(deniedRetry.status).toBe(403);

        // An administrator retries it through the staff API once the cause is fixed.
        const admin = await createMember(database, "Dead Letter Admin", ["administrators"]);
        const allowedList = await authorizeStaffRoute(
          route("events.deadLetters.list"),
          staffContext({
            sql: staffSql,
            memberId: admin,
            path: "/api/staff/events/dead-letters",
          }),
        );
        expect(allowedList.status).toBe(200);
        expect(await allowedList.json()).toMatchObject({ total: 1 });

        failing = false;
        const retried = await authorizeStaffRoute(
          route("events.deadLetters.retry"),
          staffContext({
            sql: staffSql,
            memberId: admin,
            path: "/api/staff/events/dead-letters",
            method: "POST",
            body: { id: jobId },
          }),
        );
        expect(retried.status).toBe(200);
        expect(await retried.json()).toEqual({ ok: true, queue: "domain-events" });

        await waitForState(database.sql, jobId, "completed");
        expect(handled).toBeGreaterThanOrEqual(2);
        expect(await listDeadLetters(staffSql)).toEqual({ entries: [], total: 0 });

        const [log] = (await database.sql`
          SELECT action, target_type, target_id, summary FROM core.admin_log
          WHERE action = 'events.dead_letter.retry'
        `) as Array<{
          action: string;
          target_type: string;
          target_id: string | null;
          summary: { queue: string; jobId: string };
        }>;

        expect(log).toEqual({
          action: "events.dead_letter.retry",
          target_type: "job",
          target_id: null,
          summary: { queue: "domain-events", jobId },
        });
      } finally {
        await boss.stop();
        await staffSql.close();
      }
    });
  }, 60_000);

  test("retry only accepts a currently failed job", async () => {
    await withDb("dead_letters_missing", async (database) => {
      const staffSql = new SQL(roleUrl(database.url, "staff_api"));

      try {
        expect(await retryDeadLetter(staffSql, "not-a-uuid")).toBeNull();
        expect(await retryDeadLetter(staffSql, "5e37b1f1-4f4a-4f7a-9b6c-9f7a6f5d4e3c")).toBeNull();
        expect(await listDeadLetters(staffSql)).toEqual({ entries: [], total: 0 });
      } finally {
        await staffSql.close();
      }
    });
  }, 30_000);
});
