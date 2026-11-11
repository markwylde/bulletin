import { describe, expect, test } from "bun:test";
import { displayNameSkeleton } from "@bulletin/domain/member";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  authorizeStaffRoute,
  STAFF_ROUTES,
  type StaffRoute,
} from "../../apps/staff-api/src/api.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "reaction_staff" }, run);
}

async function createMember(
  database: TestDatabase,
  name: string,
  groupKey: string,
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${displayNameSkeleton(name)})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  await database.sql`
    INSERT INTO core.member_groups (member_id, group_id, is_primary)
    SELECT ${member.id}, id, true FROM core.groups WHERE key = ${groupKey}
  `;

  return member.id;
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
  memberId: string,
  target: StaffRoute,
  body?: unknown,
): Promise<Response> {
  const url = new URL(`http://staff.localhost${target.path}`);

  return authorizeStaffRoute(target, {
    request: new Request(url, {
      method: target.method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    url,
    session: { memberId, lastAuthAt: new Date() } as never,
    sql: database.sql,
    checks: [],
  });
}

integrationDescribe("staff reaction set", () => {
  test("requires acp.access and acp.reactions and logs every change", async () => {
    await withDb(async (database) => {
      const admin = await createMember(database, "Reaction Admin", "administrators");
      const member = await createMember(database, "Reaction Member", "members");
      const list = route("reactions.list");
      const mutate = route("reactions.mutate");

      expect(list.permission).toBe("acp.reactions");
      expect(mutate.permission).toBe("acp.reactions");

      const empty = await call(database, admin, list);
      expect(empty.status).toBe(200);
      expect((await empty.json()) as unknown).toEqual({ reactions: [] });

      // A member with no ACP permission at all is refused by every staff route.
      expect((await call(database, member, list)).status).toBe(403);
      expect(
        (
          await call(database, member, mutate, {
            action: "save",
            reaction: { key: "like", icon: "👍", labelKey: "reaction.label.like", weight: 0 },
          })
        ).status,
      ).toBe(403);

      // acp.access alone is not enough: the section permission is checked too.
      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'acp.access', 'true'::jsonb FROM core.groups WHERE key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
      expect((await call(database, member, list)).status).toBe(403);

      const saved = await call(database, admin, mutate, {
        action: "save",
        reaction: {
          key: "like",
          icon: "👍",
          labelKey: "reaction.label.like",
          weight: 1,
          position: 0,
          enabled: true,
        },
      });
      expect(saved.status).toBe(200);
      const savedBody = (await saved.json()) as { id: string };
      expect(savedBody.id).toMatch(/^\d+$/);

      const listed = await call(database, admin, list);
      expect((await listed.json()) as unknown).toEqual({
        reactions: [
          {
            id: savedBody.id,
            key: "like",
            icon: "👍",
            labelKey: "reaction.label.like",
            weight: 1,
            position: 0,
            enabled: true,
          },
        ],
      });

      const moved = await call(database, admin, mutate, {
        action: "move",
        id: savedBody.id,
        direction: "down",
      });
      expect(moved.status).toBe(200);

      const deleted = await call(database, admin, mutate, {
        action: "delete",
        id: savedBody.id,
      });
      expect(deleted.status).toBe(200);

      const log = (await database.sql`
        SELECT action, target_id::text AS target_id
        FROM core.admin_log
        WHERE target_type = 'reaction'
        ORDER BY id
      `) as Array<{ action: string; target_id: string | null }>;
      expect(log).toEqual([
        { action: "reaction.create", target_id: savedBody.id },
        { action: "reaction.reorder", target_id: savedBody.id },
        { action: "reaction.delete", target_id: savedBody.id },
      ]);
    });
  }, 45_000);
});
