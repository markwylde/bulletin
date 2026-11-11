import { describe, expect, test } from "bun:test";
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
  themesSeedModule,
} from "@bulletin/db/seed";
import { giveReputation } from "@bulletin/domain/reputation";
import { startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  authorizeStaffRoute,
  STAFF_ROUTES,
  type StaffRoute,
} from "../../apps/staff-api/src/api.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "reputation_staff" }, async (database) => {
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
        themesSeedModule,
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

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

function route(id: string): StaffRoute {
  const found = STAFF_ROUTES.find((entry) => entry.id === id);

  if (found === undefined) {
    throw new Error(`Missing staff route ${id}`);
  }

  return found;
}

function call(
  database: TestDatabase,
  actorId: string,
  target: StaffRoute,
  query: Record<string, string> = {},
  body?: unknown,
): Promise<Response> {
  const url = new URL(`http://staff.localhost${target.path}`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return authorizeStaffRoute(target, {
    request: new Request(url, {
      method: target.method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    url,
    session: { memberId: actorId, lastAuthAt: new Date() } as never,
    sql: database.sql,
    checks: [],
  });
}

integrationDescribe("staff reputation tools", () => {
  test("requires members.reputation, logs removals and recounts the member", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const giver = await memberId(database, "member-1");
      const author = await memberId(database, "member-2");
      const topic = await startTopic(database.sql, {
        actorId: author,
        forumId: await forumId(database, "off-topic"),
        title: "Staff reputation target",
        bodyMd: "A rated post.",
      });

      if (!topic.ok) {
        throw new Error("Could not start the topic");
      }

      const given = await giveReputation(database.sql, {
        actorId: giver,
        postId: topic.result.postId,
        points: 1,
      });
      expect(given.ok).toBe(true);

      // ACP section access alone is not the capability: members.reputation is checked too.
      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT g.id, p.permission, to_jsonb(true)
        FROM core.groups g
        CROSS JOIN (VALUES ('acp.access'), ('acp.members')) AS p (permission)
        WHERE g.key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;

      const list = route("members.reputation.get");
      const mutate = route("members.reputation.update");

      expect((await call(database, giver, list, { memberId: author })).status).toBe(403);

      const visible = await call(database, admin, list, { memberId: author });
      expect(visible.status).toBe(200);
      const view = (await visible.json()) as {
        memberId: string;
        total: number;
        entries: Array<{ id: string; points: number; source: string }>;
      };
      expect(view.memberId).toBe(author);
      expect(view.total).toBe(1);
      expect(view.entries).toHaveLength(1);
      expect(view.entries[0]).toMatchObject({ points: 1, source: "vote" });

      const removed = await call(
        database,
        admin,
        mutate,
        {},
        {
          action: "remove",
          memberId: author,
          entryId: view.entries[0]?.id,
        },
      );
      expect(removed.status).toBe(200);
      expect((await removed.json()) as unknown).toMatchObject({ ok: true, total: 0 });

      await database.sql`
        UPDATE core.members SET reputation = 999 WHERE id = ${author}
      `;
      const recounted = await call(
        database,
        admin,
        mutate,
        {},
        {
          action: "recount",
          memberId: author,
        },
      );
      expect(recounted.status).toBe(200);
      expect((await recounted.json()) as unknown).toMatchObject({ ok: true, total: 0 });

      const log = (await database.sql`
        SELECT action FROM core.admin_log
        WHERE target_type = 'member' AND target_id = ${author}
        ORDER BY id
      `) as Array<{ action: string }>;
      expect(log.map((row) => row.action)).toEqual([
        "member.reputation.remove",
        "member.reputation.recount",
      ]);

      // A member without ACP access cannot reach the route at all.
      expect((await call(database, author, list, { memberId: author })).status).toBe(403);
    });
  }, 60_000);
});
