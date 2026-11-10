import { describe, expect, test } from "bun:test";
import { displayNameSkeleton } from "@bulletin/domain/member";
import {
  bumpPermVersion,
  CapabilityView,
  createPermissionService,
  type ForumAction,
  forumActionMask,
  loadForumTree,
  readPermVersion,
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

async function createForum(
  database: TestDatabase,
  parentId: string | null = null,
  passwordHash: string | null = null,
): Promise<string> {
  const [forum] = (await database.sql`
    INSERT INTO core.forums (parent_id, password_hash)
    VALUES (${parentId}, ${passwordHash})
    RETURNING id
  `) as Array<{ id: string }>;

  if (forum === undefined) {
    throw new Error("Could not create forum");
  }

  return forum.id;
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

async function createMask(database: TestDatabase, key: string): Promise<string> {
  const [mask] = (await database.sql`
    INSERT INTO core.masks (key, title)
    VALUES (${key}, ${key})
    RETURNING id
  `) as Array<{ id: string }>;

  if (mask === undefined) {
    throw new Error(`Could not create mask ${key}`);
  }

  return mask.id;
}

async function setMatrix(
  database: TestDatabase,
  forumId: string,
  maskId: string,
  actions: readonly ForumAction[],
  inherits = false,
): Promise<void> {
  await database.sql`
    INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
    VALUES (${forumId}, ${maskId}, ${forumActionMask(actions)}, ${inherits})
    ON CONFLICT (forum_id, mask_id) DO UPDATE
      SET actions = EXCLUDED.actions, inherits = EXCLUDED.inherits, updated_at = now()
  `;
}

integrationDescribe("permission snapshot", () => {
  test("compiles masks, inheritance, read-implies-show and the ancestor rule", async () => {
    await withDb("snapshot_compile", async (database) => {
      const members = await createMember(database, "Snapshot Member", ["members"]);
      const maskId = await createMask(database, "standard");
      const membersGroup = (await database.sql`
        SELECT id FROM core.groups WHERE key = 'members'
      `) as Array<{ id: string }>;

      const groupId = membersGroup[0]?.id;

      if (groupId === undefined) {
        throw new Error("Missing members group");
      }

      await database.sql`
        INSERT INTO core.group_masks (group_id, mask_id) VALUES (${groupId}, ${maskId})
      `;

      const category = await createForum(database);
      const support = await createForum(database, category);
      const billing = await createForum(database, support);
      const hidden = await createForum(database);
      const hiddenChild = await createForum(database, hidden);
      const readOnly = await createForum(database);
      const showOnly = await createForum(database);

      await setMatrix(database, category, maskId, ["show", "read", "reply"]);
      await setMatrix(database, support, maskId, [], true);
      await setMatrix(database, billing, maskId, ["show", "read"]);
      await setMatrix(database, hidden, maskId, []);
      await setMatrix(database, hiddenChild, maskId, ["show", "read", "reply"]);
      await setMatrix(database, readOnly, maskId, ["read"]);
      await setMatrix(database, showOnly, maskId, ["show"]);

      const tree = await loadForumTree(database.sql);
      const service = createPermissionService({ sql: database.sql });
      const snapshot = await service.snapshot(members);
      const capability = new CapabilityView({ ...snapshot });

      expect(capability.read(category)).toBe(true);
      expect(capability.has(category, "reply")).toBe(true);
      expect(capability.has(support, "reply")).toBe(true);
      expect(capability.read(billing)).toBe(true);
      expect(capability.has(billing, "reply")).toBe(false);
      expect(capability.has(hidden, "show")).toBe(false);
      expect(capability.read(hiddenChild)).toBe(false);
      expect(snapshot.bits.get(hiddenChild)).toBe(0);
      expect(capability.has(readOnly, "show")).toBe(true);
      expect(capability.has(showOnly, "show")).toBe(true);
      expect(capability.read(showOnly)).toBe(false);

      expect(await service.can(members, "reply", { forumId: support, tree })).toBe(true);
      expect(await service.can(members, "read", { forumId: hiddenChild, tree })).toBe(false);

      // Changing the category changes every inheriting descendant.
      await setMatrix(database, category, maskId, ["show", "read"]);
      await bumpPermVersion(database.sql);
      service.invalidate();

      expect(await service.can(members, "reply", { forumId: support, tree })).toBe(false);
      expect(await service.can(members, "read", { forumId: support, tree })).toBe(true);
    });
  }, 30_000);

  test("a shared mask changes the access of every linked group", async () => {
    await withDb("snapshot_shared_mask", async (database) => {
      const forum = await createForum(database);
      const maskId = await createMask(database, "standard");
      await createGroup(database, "regulars", "Regulars");

      const groups = (await database.sql`
        SELECT key, id FROM core.groups WHERE key IN ('members', 'regulars') ORDER BY key
      `) as Array<{ key: string; id: string }>;

      for (const group of groups) {
        await database.sql`
          INSERT INTO core.group_masks (group_id, mask_id) VALUES (${group.id}, ${maskId})
        `;
      }

      await setMatrix(database, forum, maskId, ["show", "read", "reply"]);

      const memberOnly = await createMember(database, "Only Member", ["members"]);
      const both = await createMember(database, "Both Groups", ["members", "regulars"]);
      const tree = await loadForumTree(database.sql);
      const service = createPermissionService({ sql: database.sql });

      expect(await service.can(memberOnly, "reply", { forumId: forum, tree })).toBe(true);
      expect(await service.can(both, "reply", { forumId: forum, tree })).toBe(true);

      await setMatrix(database, forum, maskId, ["show", "read"]);
      await bumpPermVersion(database.sql);
      service.invalidate();

      expect(await service.can(memberOnly, "reply", { forumId: forum, tree })).toBe(false);
      expect(await service.can(both, "reply", { forumId: forum, tree })).toBe(false);
    });
  }, 30_000);

  test("revokes read in a cached snapshot within the one-second backstop", async () => {
    await withDb("snapshot_revoke", async (database) => {
      const forum = await createForum(database);
      const maskId = await createMask(database, "standard");
      const membersGroup = (await database.sql`
        SELECT id FROM core.groups WHERE key = 'members'
      `) as Array<{ id: string }>;
      const groupId = membersGroup[0]?.id;

      if (groupId === undefined) {
        throw new Error("Missing members group");
      }

      await database.sql`
        INSERT INTO core.group_masks (group_id, mask_id) VALUES (${groupId}, ${maskId})
      `;
      await setMatrix(database, forum, maskId, ["show", "read"]);

      const member = await createMember(database, "Revoked Member", ["members"]);
      const tree = await loadForumTree(database.sql);
      let clock = 0;
      const service = createPermissionService({ sql: database.sql, now: () => clock });

      expect(await service.can(member, "read", { forumId: forum, tree })).toBe(true);
      const before = await readPermVersion(database.sql);

      await setMatrix(database, forum, maskId, ["show"]);
      const after = await bumpPermVersion(database.sql);
      expect(Number(after)).toBe(Number(before) + 1);

      clock = 500;
      expect(await service.can(member, "read", { forumId: forum, tree })).toBe(true);

      clock = 1_000;
      expect(await service.can(member, "read", { forumId: forum, tree })).toBe(false);
    });
  }, 30_000);

  test("banned members keep read access but lose moderator powers", async () => {
    await withDb("snapshot_banned", async (database) => {
      const forum = await createForum(database);
      const maskId = await createMask(database, "standard");
      const groups = (await database.sql`
        SELECT key, id FROM core.groups
        WHERE key IN ('members', 'super_moderators', 'banned')
      `) as Array<{ key: string; id: string }>;
      const membersGroup = groups.find((group) => group.key === "members")?.id;
      const superModerators = groups.find((group) => group.key === "super_moderators")?.id;
      const bannedGroup = groups.find((group) => group.key === "banned")?.id;

      if (
        membersGroup === undefined ||
        superModerators === undefined ||
        bannedGroup === undefined
      ) {
        throw new Error("Missing built-in groups");
      }

      await database.sql`
        INSERT INTO core.group_masks (group_id, mask_id) VALUES (${membersGroup}, ${maskId})
      `;
      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${superModerators}, 'moderation.pin', 'true'::jsonb)
      `;
      await setMatrix(database, forum, maskId, ["show", "read"]);

      const member = await createMember(database, "Banned Snapshot Member", [
        "members",
        "super_moderators",
      ]);
      const tree = await loadForumTree(database.sql);
      const service = createPermissionService({ sql: database.sql });

      expect(await service.can(member, "pin", { forumId: forum, tree })).toBe(true);

      await database.sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        VALUES (${member}, ${bannedGroup}, false)
      `;

      expect(await service.can(member, "pin", { forumId: forum, tree })).toBe(false);
      expect(await service.can(member, "read", { forumId: forum, tree })).toBe(true);
    });
  }, 30_000);

  test("password locks gate moderator powers until the session unlocks", async () => {
    await withDb("snapshot_mod_unlocks", async (database) => {
      const passwordHash = await Bun.password.hash("let-me-in");
      const forum = await createForum(database, null, passwordHash);
      const maskId = await createMask(database, "standard");
      const groups = (await database.sql`
        SELECT key, id FROM core.groups WHERE key IN ('members', 'super_moderators')
      `) as Array<{ key: string; id: string }>;
      const membersGroup = groups.find((group) => group.key === "members")?.id;
      const superModerators = groups.find((group) => group.key === "super_moderators")?.id;

      if (membersGroup === undefined || superModerators === undefined) {
        throw new Error("Missing built-in groups");
      }

      await database.sql`
        INSERT INTO core.group_masks (group_id, mask_id) VALUES (${membersGroup}, ${maskId})
      `;
      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${superModerators}, 'moderation.pin', 'true'::jsonb)
      `;
      await setMatrix(database, forum, maskId, ["show", "read"]);

      const member = await createMember(database, "Locked Moderator", [
        "members",
        "super_moderators",
      ]);
      const [session] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (
          ${member}, 'user', sha256(convert_to(${crypto.randomUUID()}, 'UTF8')),
          now() + interval '24 hours'
        )
        RETURNING id
      `) as Array<{ id: string }>;

      if (session === undefined) {
        throw new Error("Could not create session");
      }

      const tree = await loadForumTree(database.sql);
      const service = createPermissionService({ sql: database.sql });

      expect(
        await service.can(member, "pin", { forumId: forum, tree, sessionId: session.id }),
      ).toBe(false);

      await database.sql`
        INSERT INTO core.session_grants (session_id, kind, resource_id)
        VALUES (${session.id}, 'forum_password', ${forum})
      `;

      expect(
        await service.can(member, "pin", { forumId: forum, tree, sessionId: session.id }),
      ).toBe(true);

      await database.sql`DELETE FROM core.sessions WHERE id = ${session.id}`;
      expect(
        await service.can(member, "pin", { forumId: forum, tree, sessionId: session.id }),
      ).toBe(false);
    });
  }, 30_000);

  test("folds session unlocks into read and removes them with the session", async () => {
    await withDb("snapshot_unlocks", async (database) => {
      const passwordHash = await Bun.password.hash("let-me-in");
      const forum = await createForum(database, null, passwordHash);
      const maskId = await createMask(database, "standard");
      const membersGroup = (await database.sql`
        SELECT id FROM core.groups WHERE key = 'members'
      `) as Array<{ id: string }>;
      const groupId = membersGroup[0]?.id;

      if (groupId === undefined) {
        throw new Error("Missing members group");
      }

      await database.sql`
        INSERT INTO core.group_masks (group_id, mask_id) VALUES (${groupId}, ${maskId})
      `;
      await setMatrix(database, forum, maskId, ["show", "read"]);

      const member = await createMember(database, "Password Member", ["members"]);
      const [session] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (
          ${member}, 'user', sha256(convert_to(${crypto.randomUUID()}, 'UTF8')),
          now() + interval '24 hours'
        )
        RETURNING id
      `) as Array<{ id: string }>;

      if (session === undefined) {
        throw new Error("Could not create session");
      }

      const service = createPermissionService({ sql: database.sql });
      const locked = await service.snapshot(member, { sessionId: session.id });
      expect(new CapabilityView({ ...locked }).read(forum)).toBe(false);

      await database.sql`
        INSERT INTO core.session_grants (session_id, kind, resource_id)
        VALUES (${session.id}, 'forum_password', ${forum})
      `;

      const unlocked = await service.snapshot(member, { sessionId: session.id });
      const capability = new CapabilityView({ ...unlocked });
      expect(capability.read(forum)).toBe(true);
      expect(capability.isCdnCacheable()).toBe(false);

      await database.sql`DELETE FROM core.sessions WHERE id = ${session.id}`;
      const ended = await service.snapshot(member, { sessionId: session.id });
      expect(new CapabilityView({ ...ended }).read(forum)).toBe(false);
    });
  }, 30_000);
});
