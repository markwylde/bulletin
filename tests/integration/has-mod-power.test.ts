import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  createSeededRng,
  membersSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { displayNameSkeleton } from "@bulletin/domain/member";
import {
  can,
  createForumTree,
  loadModeratorContext,
  MODERATOR_POWERS,
  type ModeratorPower,
  moderatorPowerAllowed,
} from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

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

function arrayLiteral(values: readonly string[]): string {
  return `{${values.join(",")}}`;
}

interface ForestNode {
  readonly id: string;
  readonly parentId: string | null;
}

/** Creates `roots` separate fixture trees, each with `size` forums. */
async function createForest(
  database: TestDatabase,
  rng: () => number,
  roots: number,
  size: number,
): Promise<readonly ForestNode[]> {
  const nodes: ForestNode[] = [];

  for (let rootIndex = 0; rootIndex < roots; rootIndex += 1) {
    const [root] = (await database.sql`
      INSERT INTO core.forums DEFAULT VALUES
      RETURNING id
    `) as Array<{ id: string }>;

    if (root === undefined) {
      throw new Error("Could not create the fixture root forum");
    }

    nodes.push({ id: root.id, parentId: null });
    const created = [root.id];

    for (let index = 1; index < size; index += 1) {
      const parentId = created[Math.floor(rng() * created.length)] ?? root.id;
      const [forum] = (await database.sql`
        INSERT INTO core.forums (parent_id)
        VALUES (${parentId})
        RETURNING id
      `) as Array<{ id: string }>;

      if (forum === undefined) {
        throw new Error("Could not create a fixture forum");
      }

      nodes.push({ id: forum.id, parentId });
      created.push(forum.id);
    }
  }

  return nodes;
}

async function createMember(database: TestDatabase, name: string): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${displayNameSkeleton(name)})
    RETURNING id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  return member.id;
}

async function addToGroup(
  database: TestDatabase,
  memberId: string,
  groupKey: string,
  isPrimary: boolean,
): Promise<void> {
  await database.sql`
    INSERT INTO core.member_groups (member_id, group_id, is_primary)
    SELECT ${memberId}, g.id, ${isPrimary}
    FROM core.groups g
    WHERE g.key = ${groupKey}
  `;
}

async function assignment(
  database: TestDatabase,
  values: {
    readonly forumId: string;
    readonly memberId?: string;
    readonly groupId?: string;
    readonly powers: readonly ModeratorPower[];
    readonly thisForumOnly?: boolean;
  },
): Promise<void> {
  await database.sql`
    INSERT INTO core.moderators (forum_id, member_id, group_id, powers, this_forum_only)
    VALUES (
      ${values.forumId},
      ${values.memberId ?? null},
      ${values.groupId ?? null},
      ${arrayLiteral(values.powers)}::text[],
      ${values.thisForumOnly ?? false}
    )
  `;
}

async function sqlHasModPower(
  database: TestDatabase,
  memberId: string,
  forumId: string,
  power: string,
): Promise<boolean> {
  const [row] = (await database.sql`
    SELECT core.has_mod_power(${memberId}, ${forumId}, ${power}) AS allowed
  `) as Array<{ allowed: boolean }>;
  return row?.allowed === true;
}

async function groupIds(database: TestDatabase): Promise<Map<string, string>> {
  const rows = (await database.sql`
    SELECT key, id FROM core.groups
  `) as Array<{ key: string; id: string }>;
  return new Map(rows.map((row) => [row.key, row.id]));
}

integrationDescribe("core.has_mod_power", () => {
  test("is executable by pii definer functions only", async () => {
    await withDb("mod_power_grants", async ({ sql }) => {
      const [privileges] = (await sql`
        SELECT
          has_function_privilege(
            'pii_owner', 'core.has_mod_power(bigint,bigint,text)', 'EXECUTE'
          ) AS pii_owner_execute,
          has_function_privilege(
            'staff_api', 'core.has_mod_power(bigint,bigint,text)', 'EXECUTE'
          ) AS staff_api_execute,
          has_function_privilege(
            'user_app', 'core.has_mod_power(bigint,bigint,text)', 'EXECUTE'
          ) AS user_app_execute,
          has_function_privilege(
            'user_api', 'core.has_mod_power(bigint,bigint,text)', 'EXECUTE'
          ) AS user_api_execute,
          has_function_privilege(
            'workers', 'core.has_mod_power(bigint,bigint,text)', 'EXECUTE'
          ) AS workers_execute
      `) as Array<Record<string, boolean>>;

      expect(privileges).toMatchObject({
        pii_owner_execute: true,
        staff_api_execute: false,
        user_app_execute: false,
        user_api_execute: false,
        workers_execute: false,
      });
    });
  }, 30_000);

  test("honours granular assignments, sub-forum scope and this-forum-only", async () => {
    await withDb("mod_power_scope", async (database) => {
      const [category] = (await database.sql`
        INSERT INTO core.forums DEFAULT VALUES RETURNING id
      `) as Array<{ id: string }>;
      const [support] = (await database.sql`
        INSERT INTO core.forums (parent_id) VALUES (${category?.id}) RETURNING id
      `) as Array<{ id: string }>;
      const [billing] = (await database.sql`
        INSERT INTO core.forums (parent_id) VALUES (${support?.id}) RETURNING id
      `) as Array<{ id: string }>;

      const forum = support?.id ?? "";
      const child = billing?.id ?? "";
      const root = category?.id ?? "";
      const memberId = await createMember(database, "Limited Moderator");
      await addToGroup(database, memberId, "members", true);

      await assignment(database, {
        forumId: forum,
        memberId,
        powers: ["pin", "lock"],
        thisForumOnly: false,
      });

      // Limited moderator: only the granted powers, and they reach sub-forums.
      expect(await sqlHasModPower(database, memberId, forum, "pin")).toBe(true);
      expect(await sqlHasModPower(database, memberId, forum, "lock")).toBe(true);
      expect(await sqlHasModPower(database, memberId, forum, "soft_delete")).toBe(false);
      expect(await sqlHasModPower(database, memberId, child, "pin")).toBe(true);
      expect(await sqlHasModPower(database, memberId, root, "pin")).toBe(false);

      await database.sql`
        UPDATE core.moderators SET this_forum_only = true WHERE forum_id = ${forum}
      `;

      expect(await sqlHasModPower(database, memberId, forum, "pin")).toBe(true);
      expect(await sqlHasModPower(database, memberId, child, "pin")).toBe(false);
    });
  }, 30_000);

  test("applies group assignments to every member of the group", async () => {
    await withDb("mod_power_group", async (database) => {
      const [forum] = (await database.sql`
        INSERT INTO core.forums DEFAULT VALUES RETURNING id
      `) as Array<{ id: string }>;
      const [child] = (await database.sql`
        INSERT INTO core.forums (parent_id) VALUES (${forum?.id}) RETURNING id
      `) as Array<{ id: string }>;
      const forumId = forum?.id ?? "";
      const ids = await groupIds(database);
      const groupId = ids.get("members");

      if (groupId === undefined) {
        throw new Error("Missing members group");
      }

      const memberId = await createMember(database, "Group Moderator");
      await addToGroup(database, memberId, "members", true);

      await assignment(database, {
        forumId,
        groupId,
        powers: ["pin"],
      });

      expect(await sqlHasModPower(database, memberId, forumId, "pin")).toBe(true);
      expect(await sqlHasModPower(database, memberId, child?.id ?? "", "pin")).toBe(true);
    });
  }, 30_000);

  test("grants global powers from group settings and none to banned members", async () => {
    await withDb("mod_power_global", async (database) => {
      const [forum] = (await database.sql`
        INSERT INTO core.forums DEFAULT VALUES RETURNING id
      `) as Array<{ id: string }>;
      const forumId = forum?.id ?? "";
      const ids = await groupIds(database);
      const superModerators = ids.get("super_moderators");

      if (superModerators === undefined) {
        throw new Error("Missing super moderators group");
      }

      const superMod = await createMember(database, "Global Moderator");
      await addToGroup(database, superMod, "members", true);
      await addToGroup(database, superMod, "super_moderators", false);

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${superModerators}, 'moderation.pin', 'true'::jsonb)
      `;

      expect(await sqlHasModPower(database, superMod, forumId, "pin")).toBe(true);
      expect(await sqlHasModPower(database, superMod, forumId, "warn")).toBe(false);

      const banned = await createMember(database, "Banned Moderator");
      await addToGroup(database, banned, "members", true);
      await addToGroup(database, banned, "banned", false);

      expect(await sqlHasModPower(database, banned, forumId, "pin")).toBe(false);

      const restricted = await createMember(database, "Restricted Moderator");
      await addToGroup(database, restricted, "members", true);
      await addToGroup(database, restricted, "super_moderators", false);

      const members = ids.get("members");

      if (members === undefined) {
        throw new Error("Missing members group");
      }

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${members}, 'restrictions.banned', 'true'::jsonb)
      `;

      expect(await sqlHasModPower(database, restricted, forumId, "pin")).toBe(false);
      expect(await sqlHasModPower(database, superMod, forumId, "pin")).toBe(false);
      expect(await sqlHasModPower(database, banned, forumId, "pin")).toBe(false);
    });
  }, 30_000);

  test("denies unknown powers and unknown forums", async () => {
    await withDb("mod_power_unknown", async (database) => {
      const [forum] = (await database.sql`
        INSERT INTO core.forums DEFAULT VALUES RETURNING id
      `) as Array<{ id: string }>;
      const memberId = await createMember(database, "Unknown Power Member");
      await addToGroup(database, memberId, "members", true);

      expect(await sqlHasModPower(database, memberId, forum?.id ?? "", "take_over")).toBe(false);
      expect(await sqlHasModPower(database, memberId, "999999", "pin")).toBe(false);
    });
  }, 30_000);

  test("agrees with can() across seeded members, random assignments and fixture trees", async () => {
    await withDb("mod_power_property", async (database) => {
      await runSeeds({
        sql: database.sql,
        registry: new SeedRegistry([baseSeedModule, membersSeedModule]),
      });

      const rng = createSeededRng(2026);
      const nodes = await createForest(database, rng, 4, 6);
      const tree = createForumTree(
        nodes.map((node) => ({
          id: node.id,
          parentId: node.parentId,
          passwordProtected: false,
        })),
      );

      const members = (await database.sql`
        SELECT id FROM core.members ORDER BY id
      `) as Array<{ id: string }>;
      const groups = (await database.sql`
        SELECT id, key FROM core.groups ORDER BY id
      `) as Array<{ id: string; key: string }>;
      const forumIds = tree.ids;

      const usedAssignments = new Set<string>();

      for (let index = 0; index < 12; index += 1) {
        const forumId = forumIds[Math.floor(rng() * forumIds.length)];
        const member = members[Math.floor(rng() * members.length)];
        const group = groups[Math.floor(rng() * groups.length)];

        if (forumId === undefined || member === undefined || group === undefined) {
          continue;
        }

        const useMember = rng() < 0.6;
        const key = `${forumId}:${useMember ? `member:${member.id}` : `group:${group.id}`}`;

        if (usedAssignments.has(key)) {
          continue;
        }

        usedAssignments.add(key);
        const powers = MODERATOR_POWERS.filter(() => rng() < 0.25);

        if (useMember) {
          await assignment(database, {
            forumId,
            memberId: member.id,
            powers,
            thisForumOnly: rng() < 0.3,
          });
        } else {
          await assignment(database, {
            forumId,
            groupId: group.id,
            powers,
            thisForumOnly: rng() < 0.3,
          });
        }
      }

      for (const group of groups) {
        for (const power of MODERATOR_POWERS) {
          if (rng() < 0.04) {
            await database.sql`
              INSERT INTO core.group_settings (group_id, key, value)
              VALUES (${group.id}, ${`moderation.${power}`}, 'true'::jsonb)
              ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
            `;
          }
        }
      }

      const powerList = `ARRAY[${MODERATOR_POWERS.map((power) => `'${power}'`).join(",")}]::text[]`;
      const contexts = new Map<string, Awaited<ReturnType<typeof loadModeratorContext>>>();

      for (const member of members) {
        contexts.set(member.id, await loadModeratorContext(database.sql, member.id, tree));
      }

      const mismatches: Array<{
        memberId: string;
        forumId: string;
        power: string;
        sql: boolean;
        typeScript: boolean;
      }> = [];

      let allowedRows = 0;
      let deniedRows = 0;

      for (const member of members) {
        const rows = (await database.sql.unsafe(`
          SELECT f.id AS forum_id, p.power,
                 core.has_mod_power(${member.id}, f.id, p.power) AS allowed
          FROM core.forums f
          CROSS JOIN unnest(${powerList}) AS p(power)
          ORDER BY f.id, p.power
        `)) as Array<{ forum_id: string; power: string; allowed: boolean }>;

        const context = contexts.get(member.id);

        for (const row of rows) {
          if (row.allowed) {
            allowedRows += 1;
          } else {
            deniedRows += 1;
          }

          const typeScript =
            context !== undefined &&
            moderatorPowerAllowed(context, row.forum_id, row.power as ModeratorPower);

          if (typeScript !== row.allowed) {
            mismatches.push({
              memberId: member.id,
              forumId: row.forum_id,
              power: row.power,
              sql: row.allowed,
              typeScript,
            });
          }
        }
      }

      expect(mismatches).toEqual([]);
      expect(allowedRows).toBeGreaterThan(0);
      expect(deniedRows).toBeGreaterThan(0);

      for (let sample = 0; sample < 40; sample += 1) {
        const member = members[Math.floor(rng() * members.length)];
        const forumId = forumIds[Math.floor(rng() * forumIds.length)];
        const power = MODERATOR_POWERS[Math.floor(rng() * MODERATOR_POWERS.length)];

        if (member === undefined || forumId === undefined || power === undefined) {
          continue;
        }

        expect({
          memberId: member.id,
          forumId,
          power,
          allowed: await can(database.sql, member.id, power, { forumId, tree }),
        }).toEqual({
          memberId: member.id,
          forumId,
          power,
          allowed: await sqlHasModPower(database, member.id, forumId, power),
        });
      }
    });
  }, 120_000);
});
