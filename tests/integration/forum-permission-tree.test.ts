import { describe, expect, test } from "bun:test";
import { displayNameSkeleton } from "@bulletin/domain/member";
import {
  CapabilityView,
  createPermissionService,
  loadForumTree,
} from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { listPermissionMatrix, saveMatrixCell } from "../../apps/staff-api/src/masks.ts";

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

async function createMember(
  database: TestDatabase,
  name: string,
  groupKeys: readonly string[],
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${displayNameSkeleton(name)})
    RETURNING id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  for (const [index, key] of groupKeys.entries()) {
    await database.sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      SELECT ${member.id}, g.id, ${index === 0}
      FROM core.groups g
      WHERE g.key = ${key}
    `;
  }

  return member.id;
}

async function createForum(
  database: TestDatabase,
  input: {
    readonly title: string;
    readonly slug: string;
    readonly parentId?: string | null;
    readonly type?: "category" | "forum";
  },
): Promise<string> {
  const [forum] = (await database.sql`
    INSERT INTO core.forums (parent_id, type, title, slug)
    VALUES (${input.parentId ?? null}, ${input.type ?? "forum"}, ${input.title}, ${input.slug})
    RETURNING id
  `) as Array<{ id: string }>;

  if (forum === undefined) {
    throw new Error(`Could not create forum ${input.title}`);
  }

  return forum.id;
}

async function createLinkedMask(database: TestDatabase, key: string): Promise<string> {
  const [mask] = (await database.sql`
    INSERT INTO core.masks (key, title) VALUES (${key}, ${key}) RETURNING id
  `) as Array<{ id: string }>;

  if (mask === undefined) {
    throw new Error(`Could not create mask ${key}`);
  }

  await database.sql`
    INSERT INTO core.group_masks (group_id, mask_id)
    SELECT id, ${mask.id} FROM core.groups WHERE key = 'members'
  `;

  return mask.id;
}

async function setCell(
  database: TestDatabase,
  actorMemberId: string,
  forumId: string,
  maskId: string,
  permissionAction: "show" | "read",
  allowed: boolean,
): Promise<void> {
  const result = await saveMatrixCell(database.sql, actorMemberId, {
    forumId,
    maskId,
    permissionAction,
    allowed,
  });

  expect(result).toEqual({ ok: true });
}

integrationDescribe("real forum tree permissions", () => {
  test("the matrix editor is enabled and the ancestor rule hides a deep forum", async () => {
    await withDb("forum_permission_tree", async (database) => {
      const member = await createMember(database, "Tree Member", ["members"]);
      const actor = await createMember(database, "Tree Admin", ["administrators"]);
      const maskId = await createLinkedMask(database, "standard");

      const category = await createForum(database, {
        title: "General",
        slug: "general",
        type: "category",
      });
      const level1 = await createForum(database, {
        title: "Level one",
        slug: "level-one",
        parentId: category,
      });
      const level2 = await createForum(database, {
        title: "Level two",
        slug: "level-two",
        parentId: level1,
      });
      const level3 = await createForum(database, {
        title: "Level three",
        slug: "level-three",
        parentId: level2,
      });
      const level4 = await createForum(database, {
        title: "Level four",
        slug: "level-four",
        parentId: level3,
      });
      const level5 = await createForum(database, {
        title: "Level five",
        slug: "level-five",
        parentId: level4,
      });

      const initial = await listPermissionMatrix(database.sql);

      expect(initial.enabled).toBe(true);
      expect(initial.forums.map((forum) => forum.id)).toEqual([
        category,
        level1,
        level2,
        level3,
        level4,
        level5,
      ]);

      const tree = await loadForumTree(database.sql);
      expect(tree.lineage(level5).map((node) => node.id)).toEqual([
        category,
        level1,
        level2,
        level3,
        level4,
        level5,
      ]);

      // Granting on the root inherits all the way down to the fifth level.
      await setCell(database, actor, category, maskId, "show", true);
      await setCell(database, actor, category, maskId, "read", true);

      const permitted = createPermissionService({ sql: database.sql });
      expect(await permitted.can(member, "read", { forumId: level5, tree })).toBe(true);
      expect(await permitted.can(member, "show", { forumId: level5, tree })).toBe(true);

      // Hiding the ancestor hides the subtree even though the leaf has its own rights.
      await setCell(database, actor, category, maskId, "read", false);
      await setCell(database, actor, category, maskId, "show", false);
      await setCell(database, actor, level5, maskId, "show", true);
      await setCell(database, actor, level5, maskId, "read", true);

      const denied = createPermissionService({ sql: database.sql });
      expect(await denied.can(member, "read", { forumId: level5, tree })).toBe(false);
      expect(await denied.can(member, "show", { forumId: level5, tree })).toBe(false);

      const snapshot = await denied.snapshot(member);
      const capability = new CapabilityView({ ...snapshot });
      expect(capability.has(level5, "show")).toBe(false);
      expect(capability.read(level5)).toBe(false);

      const matrix = await listPermissionMatrix(database.sql);
      const leafRow = matrix.rows.find((row) => row.forumId === level5 && row.maskId === maskId);
      const rootRow = matrix.rows.find((row) => row.forumId === category && row.maskId === maskId);

      expect(matrix.enabled).toBe(true);
      expect(leafRow?.actions).toBe(3);
      expect(rootRow?.actions).toBe(0);
    });
  }, 30_000);
});
