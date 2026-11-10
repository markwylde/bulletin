import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  createSeededRng,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { displayNameSkeleton } from "@bulletin/domain/member";
import {
  can,
  capabilityAnswer,
  createForumTree,
  forumActionMask,
  loadPermissionSnapshot,
  MODERATOR_POWERS,
  type ModeratorPower,
  type PermissionSnapshot,
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

async function grantRead(
  database: TestDatabase,
  groupKey: string,
  forumIds: readonly string[],
): Promise<void> {
  const [mask] = (await database.sql`
    INSERT INTO core.masks (key, title)
    VALUES ('test_read', 'Test Read')
    ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title
    RETURNING id
  `) as Array<{ id: string }>;

  if (mask === undefined) {
    throw new Error("Could not create the read mask");
  }

  await database.sql`
    INSERT INTO core.group_masks (group_id, mask_id)
    SELECT g.id, ${mask.id} FROM core.groups g WHERE g.key = ${groupKey}
    ON CONFLICT DO NOTHING
  `;

  for (const forumId of forumIds) {
    await database.sql`
      INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
      VALUES (${forumId}, ${mask.id}, ${forumActionMask(["show", "read"])}, false)
      ON CONFLICT (forum_id, mask_id) DO UPDATE
        SET actions = EXCLUDED.actions, inherits = EXCLUDED.inherits
    `;
  }
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
      await grantRead(database, "members", [root, forum, child]);

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
      await grantRead(database, "members", [forumId, child?.id ?? ""]);

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
      await grantRead(database, "members", [forumId]);

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

  test("treats a root row marked inherits=true as empty in SQL", async () => {
    await withDb("mod_power_root_inherits", async (database) => {
      const [forum] = (await database.sql`
        INSERT INTO core.forums DEFAULT VALUES RETURNING id
      `) as Array<{ id: string }>;
      const [mask] = (await database.sql`
        INSERT INTO core.masks (key, title) VALUES ('root_inherit', 'Root inherit') RETURNING id
      `) as Array<{ id: string }>;
      const ids = await groupIds(database);
      const members = ids.get("members");
      const superModerators = ids.get("super_moderators");

      if (forum === undefined || mask === undefined || members === undefined) {
        throw new Error("Missing seed rows");
      }

      await database.sql`
        INSERT INTO core.group_masks (group_id, mask_id) VALUES (${members}, ${mask.id})
      `;
      await database.sql`
        INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
        VALUES (${forum.id}, ${mask.id}, ${forumActionMask(["show", "read"])}, true)
      `;

      const memberId = await createMember(database, "Root Inherit Member");
      await addToGroup(database, memberId, "members", true);

      if (superModerators !== undefined) {
        await addToGroup(database, memberId, "super_moderators", false);
        await database.sql`
          INSERT INTO core.group_settings (group_id, key, value)
          VALUES (${superModerators}, 'moderation.pin', 'true'::jsonb)
        `;
      }

      const [root] = (await database.sql`
        SELECT core.can_read_forum(${memberId}, ${forum.id}) AS readable
      `) as Array<{ readable: boolean }>;
      expect(root?.readable).toBe(false);
      expect(await sqlHasModPower(database, memberId, forum.id, "pin")).toBe(false);

      await database.sql`
        UPDATE core.forum_permissions SET inherits = false
        WHERE forum_id = ${forum.id} AND mask_id = ${mask.id}
      `;

      const [fixed] = (await database.sql`
        SELECT core.can_read_forum(${memberId}, ${forum.id}) AS readable
      `) as Array<{ readable: boolean }>;
      expect(fixed?.readable).toBe(true);
      expect(await sqlHasModPower(database, memberId, forum.id, "pin")).toBe(true);
    });
  }, 30_000);

  test("agrees with can() across seeded members, random assignments and fixture trees", async () => {
    await withDb("mod_power_property", async (database) => {
      await runSeeds({
        sql: database.sql,
        registry: new SeedRegistry([
          baseSeedModule,
          permissionFixtureSeedModule,
          groupsSeedModule,
          membersSeedModule,
        ]),
      });

      // The property tree is the only forum tree in the database; seeded fixture forums (and
      // their seeded moderator assignments) would otherwise be compared against a TS tree that
      // does not contain them.
      await database.sql`DELETE FROM core.forums`;

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

      // A partial read matrix: some forums are readable, some are hidden or inherit a hidden
      // parent. The property test must exercise both allowed and denied forums.
      const [readMask] = (await database.sql`
        INSERT INTO core.masks (key, title)
        VALUES ('property_read', 'Property Read')
        ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title
        RETURNING id
      `) as Array<{ id: string }>;

      if (readMask === undefined) {
        throw new Error("Could not create the property read mask");
      }

      await database.sql`
        INSERT INTO core.group_masks (group_id, mask_id)
        SELECT g.id, ${readMask.id} FROM core.groups g
        ON CONFLICT DO NOTHING
      `;

      for (const forumId of forumIds) {
        const roll = rng();

        if (roll < 0.6) {
          await database.sql`
            INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
            VALUES (${forumId}, ${readMask.id}, ${forumActionMask(["show", "read"])}, false)
          `;
        } else if (roll < 0.8) {
          await database.sql`
            INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
            VALUES (${forumId}, ${readMask.id}, 0, false)
          `;
        }
        // The remaining forums inherit from their parent (or default to no access at a root).
      }

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
      const snapshots = new Map<string, PermissionSnapshot>();

      for (const member of members) {
        snapshots.set(
          member.id,
          await loadPermissionSnapshot(database.sql, member.id, { tree, sessionId: null }),
        );
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

        const snapshot = snapshots.get(member.id);

        for (const row of rows) {
          if (row.allowed) {
            allowedRows += 1;
          } else {
            deniedRows += 1;
          }

          const typeScript =
            snapshot !== undefined &&
            capabilityAnswer(snapshot, row.forum_id, row.power as ModeratorPower);

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
