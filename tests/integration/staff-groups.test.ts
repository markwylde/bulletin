import { describe, expect, test } from "bun:test";
import { createAuthService, createCsrfToken, hashToken } from "@bulletin/domain/auth";
import { displayNameSkeleton } from "@bulletin/domain/member";
import { forumActionMask, readPermVersion } from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authIssuer, staffOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import {
  createStaffApi,
  STAFF_ROUTES,
  type StaffApi,
  type StaffRoute,
} from "../../apps/staff-api/src/api.ts";
import { saveMatrixCell } from "../../apps/staff-api/src/masks.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const ISSUER = authIssuer();
const STAFF_ORIGIN = staffOrigin();
const STAFF_CLIENT = "bulletin-staff";
const SESSION_SECRET = "test-session-secret";

interface StaffSession {
  readonly cookie: string;
  readonly memberId: string;
  readonly sessionId: string;
}

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

async function createMember(
  database: TestDatabase,
  name: string,
  groups: readonly string[],
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton, last_active_at)
    VALUES (${name}, ${displayNameSkeleton(name)}, now())
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

async function createSession(database: TestDatabase, memberId: string): Promise<StaffSession> {
  const token = crypto.randomUUID();
  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, last_auth_at)
    VALUES (
      ${memberId}, 'staff', ${hashToken(token)},
      now() + interval '12 hours', now()
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (session === undefined) {
    throw new Error("Could not create staff session");
  }

  return { cookie: token, memberId, sessionId: session.id };
}

async function createStaffApiFor(database: TestDatabase): Promise<{
  api: StaffApi;
  auth: Awaited<ReturnType<typeof createAuthService>>;
  sql: SQL;
}> {
  const sql = new SQL(roleUrl(database.url, "staff_api"));
  const auth = await createAuthService({
    sql,
    kind: "staff",
    issuer: ISSUER,
    jwksUrl: "http://127.0.0.1:1/jwks.json",
    clientId: STAFF_CLIENT,
    origin: STAFF_ORIGIN,
    sessionSecret: SESSION_SECRET,
    nodeEnv: "test",
    cacheTtlMs: 0,
  });
  const api = createStaffApi({ auth, sql });

  return { api, auth, sql };
}

async function call(
  api: StaffApi,
  session: StaffSession,
  routeId: string,
  body?: unknown,
): Promise<Response> {
  const route = STAFF_ROUTES.find((candidate) => candidate.id === routeId);

  if (route === undefined) {
    throw new Error(`No route ${routeId}`);
  }

  return callPath(api, session, route.method, route.path, body);
}

async function callPath(
  api: StaffApi,
  session: StaffSession,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({ cookie: `bl_staff=${session.cookie}` });

  if (method !== "GET") {
    headers.set("origin", STAFF_ORIGIN);
    headers.set("x-bulletin-csrf", createCsrfToken(session.sessionId, SESSION_SECRET));

    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
  }

  return api.handle(
    new Request(`http://api.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function groupId(database: TestDatabase, key: string): Promise<string> {
  const [group] = (await database.sql`
    SELECT id FROM core.groups WHERE key = ${key}
  `) as Array<{ id: string }>;

  if (group === undefined) {
    throw new Error(`Missing group ${key}`);
  }

  return group.id;
}

async function createGroup(database: TestDatabase, key: string): Promise<string> {
  const [group] = (await database.sql`
    INSERT INTO core.groups (key, title, display_order)
    VALUES (${key}, ${key}, 100)
    RETURNING id
  `) as Array<{ id: string }>;

  if (group === undefined) {
    throw new Error(`Could not create ${key}`);
  }

  return group.id;
}

async function createForum(
  database: TestDatabase,
  parentId: string | null = null,
): Promise<string> {
  const [forum] = (await database.sql`
    INSERT INTO core.forums (parent_id) VALUES (${parentId}) RETURNING id
  `) as Array<{ id: string }>;

  if (forum === undefined) {
    throw new Error("Could not create forum");
  }

  return forum.id;
}

integrationDescribe("staff group and permission screens", () => {
  test("denies the new screens without their ACP permission", async () => {
    await withDb("staff_groups_denied", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const regular = await createMember(database, "Regular Denied", ["members"]);
        const regularSession = await createSession(database, regular);
        const superMod = await createMember(database, "Super Mod Denied", [
          "members",
          "super_moderators",
        ]);
        const superSession = await createSession(database, superMod);

        for (const routeId of [
          "groups.list",
          "groups.settings.list",
          "masks.list",
          "groups.member.get",
          "promotions.list",
        ]) {
          expect((await call(api, regularSession, routeId)).status).toBe(403);
        }

        // Super moderators have acp.members only.
        expect((await call(api, superSession, "moderators.list")).status).toBe(200);
        expect((await call(api, superSession, "groups.list")).status).toBe(403);
        expect((await call(api, superSession, "masks.list")).status).toBe(403);
        expect((await call(api, superSession, "groups.member.get")).status).toBe(403);
        expect((await call(api, superSession, "promotions.list")).status).toBe(403);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("requires fresh authentication for permission mutations", async () => {
    await withDb("staff_groups_step_up", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const admin = await createMember(database, "Step Up Admin", ["administrators"]);
        const stale = await createSession(database, admin);
        await database.sql`
          UPDATE core.sessions
          SET last_auth_at = now() - interval '16 minutes'
          WHERE id = ${stale.sessionId}
        `;

        for (const routeId of [
          "groups.update",
          "groups.member.update",
          "masks.update",
          "moderators.update",
          "promotions.update",
        ]) {
          const response = await call(api, stale, routeId, { action: "invalid" });
          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({ code: "step_up_required" });
        }

        // Reading the screen is not a sensitive mutation and still works.
        expect((await call(api, stale, "groups.list")).status).toBe(200);

        const fresh = await createSession(database, admin);
        const allowed = await call(api, fresh, "groups.update", {
          action: "create",
          key: `step_up_fresh_${Date.now()}`,
          title: "Fresh Step Up",
          displayOrder: 100,
        });
        expect(allowed.status).toBe(200);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("creates, updates, reorders and deletes groups with a replacement", async () => {
    await withDb("staff_groups_crud", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const admin = await createMember(database, "Group Admin", ["administrators"]);
        const session = await createSession(database, admin);

        const created = await call(api, session, "groups.update", {
          action: "create",
          key: "regulars",
          title: "Regulars",
          displayOrder: 100,
          nameColour: "#c0a000",
          icon: "star",
        });
        expect(created.status).toBe(200);

        const list = (await (await call(api, session, "groups.list")).json()) as {
          groups: Array<{ key: string; title: string; displayOrder: number }>;
        };
        expect(list.groups.find((group) => group.key === "regulars")).toMatchObject({
          title: "Regulars",
          displayOrder: 100,
        });

        const regulars = await groupId(database, "regulars");
        const members = await groupId(database, "members");
        const member = await createMember(database, "Promoted Groups Member", ["members"]);
        await database.sql`
          UPDATE core.member_groups
          SET group_id = ${regulars}
          WHERE member_id = ${member} AND is_primary
        `;

        const withoutReplacement = await call(api, session, "groups.update", {
          action: "delete",
          id: regulars,
        });
        expect(withoutReplacement.status).toBe(409);
        expect(await withoutReplacement.json()).toEqual({ code: "replacement_required" });

        const deleted = await call(api, session, "groups.update", {
          action: "delete",
          id: regulars,
          replacementGroupId: members,
        });
        expect(deleted.status).toBe(200);

        const rows = (await database.sql`
          SELECT g.key, mg.is_primary
          FROM core.member_groups mg
          JOIN core.groups g ON g.id = mg.group_id
          WHERE mg.member_id = ${member}
        `) as Array<{ key: string; is_primary: boolean }>;
        expect(rows).toEqual([{ key: "members", is_primary: true }]);

        const systemDelete = await call(api, session, "groups.update", {
          action: "delete",
          id: members,
        });
        expect(systemDelete.status).toBe(409);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("refuses to delete a group that scopes an announcement or prefix", async () => {
    await withDb("staff_groups_in_use", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const admin = await createMember(database, "In Use Admin", ["administrators"]);
        const session = await createSession(database, admin);
        const group = await createGroup(database, "restricted_audience");
        const [announcement] = (await database.sql`
          INSERT INTO core.announcements (title, scope)
          VALUES ('Restricted notice', 'global')
          RETURNING id
        `) as Array<{ id: string }>;
        const [prefix] = (await database.sql`
          INSERT INTO core.prefixes (key) VALUES ('restricted_label') RETURNING id
        `) as Array<{ id: string }>;

        if (announcement === undefined || prefix === undefined) {
          throw new Error("Could not create the restricting rows");
        }

        await database.sql`
          INSERT INTO core.announcement_groups (announcement_id, group_id)
          VALUES (${announcement.id}, ${group})
        `;
        await database.sql`
          INSERT INTO core.prefix_groups (prefix_id, group_id)
          VALUES (${prefix.id}, ${group})
        `;

        const refused = await call(api, session, "groups.update", {
          action: "delete",
          id: group,
        });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({ code: "group_in_use" });

        const [remaining] = (await database.sql`
          SELECT count(*)::int AS groups FROM core.groups WHERE id = ${group}
        `) as Array<{ groups: number }>;
        expect(remaining?.groups).toBe(1);

        await database.sql`DELETE FROM core.announcement_groups WHERE group_id = ${group}`;
        await database.sql`DELETE FROM core.prefix_groups WHERE group_id = ${group}`;

        const deleted = await call(api, session, "groups.update", {
          action: "delete",
          id: group,
        });
        expect(deleted.status).toBe(200);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("saves a group setting cell and bumps perm", async () => {
    await withDb("staff_group_settings", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const admin = await createMember(database, "Settings Admin", ["administrators"]);
        const session = await createSession(database, admin);
        const members = await groupId(database, "members");
        const before = Number(await readPermVersion(database.sql));

        const response = await call(api, session, "groups.update", {
          action: "setting",
          groupId: members,
          key: "posting.can_react",
          value: false,
        });
        expect(response.status).toBe(200);

        const [stored] = (await database.sql`
          SELECT value FROM core.group_settings
          WHERE group_id = ${members} AND key = 'posting.can_react'
        `) as Array<{ value: unknown }>;
        expect(stored?.value).toBe(false);
        expect(Number(await readPermVersion(database.sql))).toBe(before + 1);

        const settings = (await (await call(api, session, "groups.settings.list")).json()) as {
          groups: Array<{ id: string; settings: Record<string, unknown> }>;
        };
        expect(settings.groups.find((group) => group.id === members)?.settings).toMatchObject({
          "posting.can_react": false,
        });
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("edits masks, links groups and bulk-toggles an inheriting forum", async () => {
    await withDb("staff_masks", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const admin = await createMember(database, "Mask Admin", ["administrators"]);
        const session = await createSession(database, admin);
        const members = await groupId(database, "members");
        const category = await createForum(database);
        const inheritingChild = await createForum(database, category);
        const overrideChild = await createForum(database, category);

        const created = await call(api, session, "masks.update", {
          action: "save",
          key: "standard",
          title: "Standard",
          description: "Default",
        });
        expect(created.status).toBe(200);

        let matrix = (await (await call(api, session, "masks.list")).json()) as {
          masks: Array<{ id: string; key: string }>;
          rows: Array<{ forumId: string; maskId: string; effectiveActions: number }>;
        };
        const mask = matrix.masks.find((candidate) => candidate.key === "standard");

        if (mask === undefined) {
          throw new Error("Missing mask");
        }

        // An explicit override on one child must survive parent bulk toggles.
        await database.sql`
          INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
          VALUES (${overrideChild}, ${mask.id}, ${forumActionMask(["show"])}, false)
        `;

        expect(
          (
            await call(api, session, "masks.update", {
              action: "link",
              groupId: members,
              maskId: mask.id,
              linked: true,
            })
          ).status,
        ).toBe(200);

        expect(
          (
            await call(api, session, "masks.update", {
              action: "bulk",
              forumId: category,
              maskId: mask.id,
              permissionAction: "read",
              allowed: true,
            })
          ).status,
        ).toBe(200);

        matrix = (await (await call(api, session, "masks.list")).json()) as typeof matrix;
        const inheritedRow = matrix.rows.find(
          (row) => row.forumId === inheritingChild && row.maskId === mask.id,
        );
        const overrideRow = matrix.rows.find(
          (row) => row.forumId === overrideChild && row.maskId === mask.id,
        );
        expect((inheritedRow?.effectiveActions ?? 0) & 2).toBe(2);
        expect((overrideRow?.effectiveActions ?? 0) & 2).toBe(0);

        // The inheriting child has no explicit row; a later parent revocation must reach it.
        const [childPermission] = (await database.sql`
          SELECT count(*)::int AS rows
          FROM core.forum_permissions
          WHERE forum_id = ${inheritingChild} AND mask_id = ${mask.id}
        `) as Array<{ rows: number }>;
        expect(childPermission?.rows).toBe(0);

        await call(api, session, "masks.update", {
          action: "cell",
          forumId: category,
          maskId: mask.id,
          permissionAction: "read",
          allowed: false,
        });
        matrix = (await (await call(api, session, "masks.list")).json()) as typeof matrix;
        expect(
          (matrix.rows.find((row) => row.forumId === inheritingChild && row.maskId === mask.id)
            ?.effectiveActions ?? 0) & 2,
        ).toBe(0);
        expect(
          (matrix.rows.find((row) => row.forumId === overrideChild && row.maskId === mask.id)
            ?.effectiveActions ?? 0) & 2,
        ).toBe(0);

        // Row bulk applies the action to every mask on one forum.
        expect(
          (
            await call(api, session, "masks.update", {
              action: "bulk",
              forumId: category,
              permissionAction: "reply",
              allowed: true,
            })
          ).status,
        ).toBe(200);

        expect(
          (
            await call(api, session, "masks.update", {
              action: "cell",
              forumId: category,
              maskId: mask.id,
              permissionAction: "reply",
              allowed: true,
            })
          ).status,
        ).toBe(200);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("serializes concurrent matrix edits so a revocation is not restored", async () => {
    await withDb("staff_masks_concurrent", async (database) => {
      const admin = await createMember(database, "Concurrent Mask Admin", ["administrators"]);
      const forum = await createForum(database);
      const [mask] = (await database.sql`
        INSERT INTO core.masks (key, title) VALUES ('concurrent', 'Concurrent')
        RETURNING id
      `) as Array<{ id: string }>;

      if (mask === undefined) {
        throw new Error("Could not create mask");
      }

      await database.sql`
        INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
        VALUES (${forum}, ${mask.id}, ${forumActionMask(["show", "read"])}, false)
      `;

      const results = await Promise.all([
        saveMatrixCell(database.sql, admin, {
          forumId: forum,
          maskId: mask.id,
          permissionAction: "read",
          allowed: false,
        }),
        saveMatrixCell(database.sql, admin, {
          forumId: forum,
          maskId: mask.id,
          permissionAction: "reply",
          allowed: true,
        }),
      ]);

      expect(results.every((result) => result.ok)).toBe(true);

      const [row] = (await database.sql`
        SELECT actions FROM core.forum_permissions
        WHERE forum_id = ${forum} AND mask_id = ${mask.id}
      `) as Array<{ actions: number }>;

      const actions = row?.actions ?? 0;
      expect(actions & 2).toBe(0);
      expect(actions & 8).toBe(8);
    });
  }, 30_000);

  test("sets a member's groups, logs the change and rotates sessions", async () => {
    await withDb("staff_member_groups", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const admin = await createMember(database, "Member Group Admin", ["administrators"]);
        const session = await createSession(database, admin);
        const regulars = await createGroup(database, "regulars");
        const members = await groupId(database, "members");
        const member = await createMember(database, "Edited Member", ["members"]);
        const targetSession = await createSession(database, member);

        const response = await call(api, session, "groups.member.update", {
          memberId: member,
          primaryGroupId: regulars,
          secondaryGroupIds: [members],
        });
        expect(response.status).toBe(200);

        const rows = (await database.sql`
          SELECT g.key, mg.is_primary
          FROM core.member_groups mg
          JOIN core.groups g ON g.id = mg.group_id
          WHERE mg.member_id = ${member}
          ORDER BY g.key
        `) as Array<{ key: string; is_primary: boolean }>;
        expect(rows).toEqual([
          { key: "members", is_primary: false },
          { key: "regulars", is_primary: true },
        ]);

        const [rotation] = (await database.sql`
          SELECT rotate_pending FROM core.sessions WHERE id = ${targetSession.sessionId}
        `) as Array<{ rotate_pending: boolean }>;
        expect(rotation?.rotate_pending).toBe(true);

        const [log] = (await database.sql`
          SELECT action FROM core.admin_log
          WHERE action = 'member.groups.update'
          ORDER BY id DESC LIMIT 1
        `) as Array<{ action: string }>;
        expect(log?.action).toBe("member.groups.update");
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("creates limited and inherited moderator assignments", async () => {
    await withDb("staff_moderators", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const admin = await createMember(database, "Moderator Admin", ["administrators"]);
        const session = await createSession(database, admin);
        const moderator = await createMember(database, "Limited Moderator", ["members"]);
        const forum = await createForum(database);
        const child = await createForum(database, forum);
        const members = await groupId(database, "members");
        const [readMask] = (await database.sql`
          INSERT INTO core.masks (key, title) VALUES ('test_read', 'Test Read')
          RETURNING id
        `) as Array<{ id: string }>;

        if (readMask === undefined) {
          throw new Error("Could not create the read mask");
        }

        await database.sql`
          INSERT INTO core.group_masks (group_id, mask_id)
          VALUES (${members}, ${readMask.id})
        `;

        for (const forumId of [forum, child]) {
          await database.sql`
            INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
            VALUES (${forumId}, ${readMask.id}, ${forumActionMask(["show", "read"])}, false)
          `;
        }

        const saved = await call(api, session, "moderators.update", {
          action: "save",
          forumId: forum,
          assigneeKind: "member",
          assigneeId: moderator,
          powers: ["pin", "lock"],
          thisForumOnly: true,
        });
        expect(saved.status).toBe(200);

        const [assignment] = (await database.sql`
          SELECT id, powers, this_forum_only FROM core.moderators
          WHERE forum_id = ${forum} AND member_id = ${moderator}
        `) as Array<{ id: string; powers: string[]; this_forum_only: boolean }>;
        expect(assignment?.powers).toEqual(["pin", "lock"]);
        expect(assignment?.this_forum_only).toBe(true);

        const listed = (await (await call(api, session, "moderators.list")).json()) as {
          assignments: Array<{
            forumId: string;
            memberName: string | null;
            powers: string[];
            thisForumOnly: boolean;
          }>;
        };
        expect(listed.assignments.find((candidate) => candidate.forumId === forum)).toMatchObject({
          memberName: "Limited Moderator",
          powers: ["pin", "lock"],
          thisForumOnly: true,
        });

        const [log] = (await database.sql`
          SELECT action FROM core.admin_log
          WHERE action = 'moderator.save'
          ORDER BY id DESC LIMIT 1
        `) as Array<{ action: string }>;
        expect(log?.action).toBe("moderator.save");

        const [power] = (await database.sql`
          SELECT core.has_mod_power(${moderator}, ${forum}, 'pin') AS on_forum,
                 core.has_mod_power(${moderator}, ${child}, 'pin') AS on_child
        `) as Array<{ on_forum: boolean; on_child: boolean }>;
        expect(power).toEqual({ on_forum: true, on_child: false });

        const removed = await call(api, session, "moderators.update", {
          action: "delete",
          id: assignment?.id ?? "",
        });
        expect(removed.status).toBe(200);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("searches and paginates members beyond the old 200-member limit", async () => {
    await withDb("staff_moderator_member_search", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const admin = await createMember(database, "Search Admin", ["administrators"]);
        const session = await createSession(database, admin);

        for (let index = 0; index < 205; index += 1) {
          const name = `Bulk Member ${String(index).padStart(3, "0")}`;
          await database.sql`
            INSERT INTO core.members (display_name, name_skeleton)
            VALUES (${name}, ${displayNameSkeleton(name)})
          `;
        }

        const firstPage = (await (
          await callPath(
            api,
            session,
            "GET",
            "/api/staff/moderators/members?query=Bulk%20Member&limit=50",
          )
        ).json()) as {
          members: Array<{ id: string; displayName: string }>;
          nextOffset: number | null;
        };
        expect(firstPage.members).toHaveLength(50);
        expect(firstPage.nextOffset).toBe(50);

        const target = (await (
          await callPath(
            api,
            session,
            "GET",
            "/api/staff/moderators/members?query=Bulk%20Member%20204",
          )
        ).json()) as { members: Array<{ id: string; displayName: string }> };

        expect(target.members).toHaveLength(1);
        const member = target.members[0];

        if (member === undefined) {
          throw new Error("Could not find the 205th member");
        }

        const forum = await createForum(database);
        const saved = await call(api, session, "moderators.update", {
          action: "save",
          forumId: forum,
          assigneeKind: "member",
          assigneeId: member.id,
          powers: ["pin"],
          thisForumOnly: true,
        });
        expect(saved.status).toBe(200);

        const [assignment] = (await database.sql`
          SELECT id FROM core.moderators
          WHERE forum_id = ${forum} AND member_id = ${member.id}
        `) as Array<{ id: string }>;
        expect(assignment).toBeDefined();
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 60_000);

  test("creates, updates and deletes promotion rules", async () => {
    await withDb("staff_promotions", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const admin = await createMember(database, "Promotion Admin", ["administrators"]);
        const session = await createSession(database, admin);
        const members = await groupId(database, "members");
        const regulars = await createGroup(database, "regulars");

        const created = await call(api, session, "promotions.update", {
          action: "save",
          fromGroupId: members,
          toGroupId: regulars,
          criteria: { days_since_joining: 30 },
          position: 0,
          enabled: true,
        });
        expect(created.status).toBe(200);

        let view = (await (await call(api, session, "promotions.list")).json()) as {
          rules: Array<{ id: string; fromGroupKey: string; toGroupKey: string }>;
        };
        expect(view.rules[0]).toMatchObject({
          fromGroupKey: "members",
          toGroupKey: "regulars",
        });

        const rule = view.rules[0];

        if (rule === undefined) {
          throw new Error("Missing promotion rule");
        }

        expect(
          (
            await call(api, session, "promotions.update", {
              action: "save",
              id: rule.id,
              fromGroupId: members,
              toGroupId: regulars,
              criteria: { days_since_joining: 60 },
              position: 1,
              enabled: false,
            })
          ).status,
        ).toBe(200);

        view = (await (await call(api, session, "promotions.list")).json()) as typeof view;
        expect(view.rules[0]?.id).toBe(rule.id);

        expect(
          (
            await call(api, session, "promotions.update", {
              action: "delete",
              id: rule.id,
            })
          ).status,
        ).toBe(200);
        expect(
          ((await (await call(api, session, "promotions.list")).json()) as { rules: unknown[] })
            .rules,
        ).toHaveLength(0);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);
});
