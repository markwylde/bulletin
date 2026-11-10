import { describe, expect, test } from "bun:test";
import { displayNameSkeleton } from "@bulletin/domain/member";
import {
  type ForumAction,
  forumActionMask,
  forumActionsFromMask,
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

async function expectRejection(query: () => PromiseLike<unknown>, pattern?: string): Promise<void> {
  try {
    await query();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (pattern !== undefined) {
      expect(message).toContain(pattern);
    }

    return;
  }

  throw new Error("Expected the statement to be rejected");
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

async function createGroup(database: TestDatabase, key: string, title: string): Promise<string> {
  const [group] = (await database.sql`
    INSERT INTO core.groups (key, title, display_order)
    VALUES (${key}, ${title}, 100)
    RETURNING id
  `) as Array<{ id: string }>;

  if (group === undefined) {
    throw new Error(`Could not create group ${key}`);
  }

  return group.id;
}

async function createForum(
  database: TestDatabase,
  parentId: string | null = null,
): Promise<string> {
  const [forum] = (await database.sql`
    INSERT INTO core.forums (parent_id)
    VALUES (${parentId})
    RETURNING id
  `) as Array<{ id: string }>;

  if (forum === undefined) {
    throw new Error("Could not create forum");
  }

  return forum.id;
}

integrationDescribe("group and permission model", () => {
  test("stores group display attributes and ordering and protects built-in groups", async () => {
    await withDb("groups_model_display", async (database) => {
      const [custom] = (await database.sql`
        INSERT INTO core.groups (key, title, display_order, name_colour, icon)
        VALUES ('regulars', 'Regulars', 60, '#c0a000', 'star')
        RETURNING id, name_colour, icon, display_order, is_system
      `) as Array<{
        id: string;
        name_colour: string;
        icon: string;
        display_order: number;
        is_system: boolean;
      }>;

      expect(custom).toMatchObject({
        name_colour: "#c0a000",
        icon: "star",
        display_order: 60,
        is_system: false,
      });

      const builtIns = (await database.sql`
        SELECT key, display_order, is_system
        FROM core.groups
        WHERE is_system
        ORDER BY display_order
      `) as Array<{ key: string; display_order: number; is_system: boolean }>;

      expect(builtIns.map((group) => group.key)).toEqual([
        "guests",
        "members",
        "banned",
        "super_moderators",
        "administrators",
      ]);

      await expectRejection(
        () => database.sql`
          INSERT INTO core.groups (key, title, name_colour)
          VALUES ('bad_colour', 'Bad colour', 'gold')
        `,
      );

      await expectRejection(
        () => database.sql`DELETE FROM core.groups WHERE key = 'administrators'`,
        "built-in group",
      );

      await database.sql`DELETE FROM core.groups WHERE id = ${custom?.id}`;

      const remaining = (await database.sql`
        SELECT 1 FROM core.groups WHERE key = 'regulars'
      `) as unknown[];
      expect(remaining).toHaveLength(0);
    });
  }, 30_000);

  test("enforces exactly one primary group per member", async () => {
    await withDb("groups_model_primary", async (database) => {
      const memberId = await createMember(database, "Primary Member");
      const memberGroup = await createGroup(database, "primary_members", "Primary Members");
      const secondaryGroup = await createGroup(database, "primary_secondary", "Primary Secondary");

      await database.sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        VALUES (${memberId}, ${memberGroup}, true)
      `;
      await database.sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        VALUES (${memberId}, ${secondaryGroup}, false)
      `;

      const rows = (await database.sql`
        SELECT is_primary FROM core.member_groups WHERE member_id = ${memberId}
      `) as Array<{ is_primary: boolean }>;
      expect(rows.filter((row) => row.is_primary)).toHaveLength(1);

      await expectRejection(
        () => database.sql`
          INSERT INTO core.member_groups (member_id, group_id, is_primary)
          VALUES (${memberId}, ${secondaryGroup}, false), (${memberId}, ${memberGroup}, true)
        `,
      );

      await expectRejection(
        () => database.sql`
          DELETE FROM core.member_groups
          WHERE member_id = ${memberId} AND is_primary
        `,
        "exactly one primary group",
      );

      const orphan = await createMember(database, "Orphan Member");
      await expectRejection(
        () => database.sql`
          INSERT INTO core.member_groups (member_id, group_id, is_primary)
          VALUES (${orphan}, ${memberGroup}, false)
        `,
        "exactly one primary group",
      );

      // Erasure deletes the member; the cascade must not trip the constraint.
      await database.sql`DELETE FROM core.members WHERE id = ${memberId}`;
      const left = (await database.sql`
        SELECT 1 FROM core.member_groups WHERE member_id = ${memberId}
      `) as unknown[];
      expect(left).toHaveLength(0);
    });
  }, 30_000);

  test("stores typed group settings and cascades them with the group", async () => {
    await withDb("groups_model_settings", async (database) => {
      const groupId = await createGroup(database, "settings_group", "Settings Group");

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES
          (${groupId}, 'posting.upload_quota_mb', '50'::jsonb),
          (${groupId}, 'posting.posts_require_approval', 'true'::jsonb),
          (${groupId}, 'display.name_colour', '"gold"'::jsonb)
      `;

      const rows = (await database.sql`
        SELECT key, value
        FROM core.group_settings
        WHERE group_id = ${groupId}
        ORDER BY key
      `) as Array<{ key: string; value: unknown }>;

      expect(rows).toEqual([
        { key: "display.name_colour", value: "gold" },
        { key: "posting.posts_require_approval", value: true },
        { key: "posting.upload_quota_mb", value: 50 },
      ]);

      await expectRejection(
        () => database.sql`
          INSERT INTO core.group_settings (group_id, key, value)
          VALUES (${groupId}, 'Bad Key', 'true'::jsonb)
        `,
      );

      await expectRejection(
        () => database.sql`
          INSERT INTO core.group_settings (group_id, key, value)
          VALUES (${groupId}, 'posting.object', '{"a": 1}'::jsonb)
        `,
      );

      await database.sql`DELETE FROM core.groups WHERE id = ${groupId}`;

      const left = (await database.sql`
        SELECT 1 FROM core.group_settings WHERE group_id = ${groupId}
      `) as unknown[];
      expect(left).toHaveLength(0);
    });
  }, 30_000);

  test("links groups to shared masks and stores action bits with inheritance", async () => {
    await withDb("groups_model_masks", async (database) => {
      const members = await createGroup(database, "mask_members", "Mask Members");
      const regulars = await createGroup(database, "mask_regulars", "Mask Regulars");

      const [mask] = (await database.sql`
        INSERT INTO core.masks (key, title, description)
        VALUES ('standard', 'Standard', 'The default forum mask')
        RETURNING id
      `) as Array<{ id: string }>;
      expect(mask).toBeDefined();
      const maskId = mask?.id;

      if (maskId === undefined) {
        throw new Error("Could not create mask");
      }

      await database.sql`
        INSERT INTO core.group_masks (group_id, mask_id)
        VALUES (${members}, ${maskId}), (${regulars}, ${maskId})
      `;

      const linked = (await database.sql`
        SELECT group_id FROM core.group_masks WHERE mask_id = ${maskId}
        ORDER BY group_id
      `) as Array<{ group_id: string }>;
      expect(linked.map((row) => row.group_id).sort()).toEqual([members, regulars].sort());

      const category = await createForum(database);
      const forum = await createForum(database, category);
      const actions: ForumAction[] = ["show", "read", "reply", "upload"];
      const bits = forumActionMask(actions);

      await database.sql`
        INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
        VALUES (${forum}, ${maskId}, ${bits}, false)
      `;

      const [stored] = (await database.sql`
        SELECT actions, inherits
        FROM core.forum_permissions
        WHERE forum_id = ${forum} AND mask_id = ${maskId}
      `) as Array<{ actions: number; inherits: boolean }>;

      expect(stored?.inherits).toBe(false);
      expect(forumActionsFromMask(stored?.actions ?? 0)).toEqual(actions);

      await expectRejection(
        () => database.sql`
          INSERT INTO core.forum_permissions (forum_id, mask_id, actions)
          VALUES (${forum}, ${maskId}, -1)
        `,
      );

      await database.sql`DELETE FROM core.forums WHERE id = ${category}`;

      const left = (await database.sql`
        SELECT 1 FROM core.forum_permissions WHERE forum_id = ${forum}
      `) as unknown[];
      expect(left).toHaveLength(0);
    });
  }, 30_000);

  test("stores moderator assignments for a member or a group with granular powers", async () => {
    await withDb("groups_model_moderators", async (database) => {
      const forum = await createForum(database);
      const parent = await createForum(database, forum);
      const memberId = await createMember(database, "Moderator Member");
      const groupId = await createGroup(database, "moderator_group", "Moderator Group");

      const [memberAssignment] = (await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers, this_forum_only)
        VALUES (${forum}, ${memberId}, ARRAY['pin', 'lock']::text[], true)
        RETURNING id, powers, this_forum_only
      `) as Array<{ id: string; powers: string[]; this_forum_only: boolean }>;

      expect(memberAssignment).toMatchObject({
        powers: ["pin", "lock"],
        this_forum_only: true,
      });

      await database.sql`
        INSERT INTO core.moderators (forum_id, group_id, powers)
        VALUES (${parent}, ${groupId}, ARRAY['edit', 'see_deleted']::text[])
      `;

      await expectRejection(
        () => database.sql`
          INSERT INTO core.moderators (forum_id, powers)
          VALUES (${forum}, ARRAY['pin']::text[])
        `,
        "one_assignee",
      );

      await expectRejection(
        () => database.sql`
          INSERT INTO core.moderators (forum_id, member_id, group_id, powers)
          VALUES (${parent}, ${memberId}, ${groupId}, ARRAY['pin']::text[])
        `,
        "one_assignee",
      );

      await expectRejection(
        () => database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers)
        VALUES (${parent}, ${memberId}, ARRAY['pin', 'take_over']::text[])
      `,
      );

      await expectRejection(
        () => database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers)
        VALUES (${forum}, ${memberId}, ARRAY['pin']::text[])
      `,
      );

      await database.sql`DELETE FROM core.forums WHERE id = ${forum}`;

      const left = (await database.sql`
        SELECT 1 FROM core.moderators WHERE forum_id IN (${forum}, ${parent})
      `) as unknown[];
      expect(left).toHaveLength(0);
    });
  }, 30_000);
});
