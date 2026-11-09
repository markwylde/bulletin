import { describe, expect, test } from "bun:test";
import { createSeededRng } from "@bulletin/db/seed";
import { displayNameSkeleton } from "@bulletin/domain/member";
import {
  ACP_PERMISSIONS,
  can,
  isAcpPermission,
  type PermissionAction,
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

async function groupIds(database: TestDatabase): Promise<Map<string, string>> {
  const rows = (await database.sql`
    SELECT key, id FROM core.groups ORDER BY key
  `) as Array<{ key: string; id: string }>;
  return new Map(rows.map((row) => [row.key, row.id]));
}

async function createMember(
  database: TestDatabase,
  name: string,
  groups: readonly string[],
  ids: Map<string, string>,
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${displayNameSkeleton(name)})
    RETURNING id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  let primary = true;

  for (const key of groups) {
    const groupId = ids.get(key);

    if (groupId === undefined) {
      throw new Error(`Missing group ${key}`);
    }

    await database.sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      VALUES (${member.id}, ${groupId}, ${primary})
    `;
    primary = false;
  }

  return member.id;
}

async function sqlHasAcp(
  database: TestDatabase,
  memberId: string,
  permission: string,
): Promise<boolean> {
  const [row] = (await database.sql`
    SELECT core.has_acp(${memberId}, ${permission}) AS granted
  `) as Array<{ granted: boolean }>;
  return row?.granted === true;
}

integrationDescribe("core.has_acp", () => {
  test("agrees with the TypeScript ACP check for generated member/group combinations", async () => {
    await withDb("has_acp_property", async (database) => {
      const ids = await groupIds(database);
      const groupKeys = [...ids.keys()];
      const permissions: string[] = [...ACP_PERMISSIONS, "acp.unknown", "not_acp"];
      const rng = createSeededRng(42);
      const members: Array<{ id: string; groups: string[] }> = [];

      for (let index = 0; index < 30; index += 1) {
        const groups = groupKeys.filter(() => rng() < 0.35);

        if (groups.length === 0) {
          groups.push("members");
        }

        const id = await createMember(
          database,
          `Property Member ${String(index).padStart(2, "0")}`,
          groups,
          ids,
        );
        members.push({ id, groups });
      }

      for (const member of members) {
        for (const permission of permissions) {
          const typeScriptResult = await can(
            database.sql,
            member.id,
            permission as PermissionAction,
          );
          const sqlResult = await sqlHasAcp(database, member.id, permission);

          expect({
            groups: member.groups.sort(),
            permission,
            typeScriptResult,
          }).toEqual({
            groups: member.groups.sort(),
            permission,
            typeScriptResult: sqlResult,
          });
        }
      }
    });
  }, 60_000);

  test("matches the built-in group grants exactly", async () => {
    await withDb("has_acp_groups", async (database) => {
      const ids = await groupIds(database);
      const administrator = await createMember(
        database,
        "Has ACP Administrator",
        ["administrators"],
        ids,
      );
      const moderator = await createMember(
        database,
        "Has ACP Moderator",
        ["members", "super_moderators"],
        ids,
      );
      const member = await createMember(database, "Has ACP Member", ["members"], ids);

      for (const permission of ACP_PERMISSIONS) {
        expect(await sqlHasAcp(database, administrator, permission)).toBe(true);
      }

      expect(await sqlHasAcp(database, moderator, "acp.access")).toBe(true);
      expect(await sqlHasAcp(database, moderator, "acp.members")).toBe(true);
      expect(await sqlHasAcp(database, moderator, "acp.settings")).toBe(false);

      for (const permission of ACP_PERMISSIONS) {
        expect(await sqlHasAcp(database, member, permission)).toBe(false);
      }

      for (const permission of ACP_PERMISSIONS) {
        expect(await can(database.sql, member, permission)).toBe(false);
      }

      expect(isAcpPermission("acp.members")).toBe(true);
      expect(isAcpPermission("acp.nope")).toBe(false);
    });
  }, 30_000);

  test("is executable by pii definer functions and denied to other app roles", async () => {
    await withDb("has_acp_grants", async ({ sql }) => {
      const [privileges] = (await sql`
        SELECT
          has_function_privilege(
            'pii_owner', 'core.has_acp(bigint,text)', 'EXECUTE'
          ) AS pii_owner_execute,
          has_function_privilege(
            'staff_api', 'core.has_acp(bigint,text)', 'EXECUTE'
          ) AS staff_api_execute,
          has_function_privilege(
            'user_app', 'core.has_acp(bigint,text)', 'EXECUTE'
          ) AS user_app_execute
      `) as Array<Record<string, boolean>>;

      expect(privileges).toMatchObject({
        pii_owner_execute: true,
        staff_api_execute: true,
        user_app_execute: false,
      });
    });
  }, 30_000);
});
