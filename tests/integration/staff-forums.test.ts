import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  emoticonSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { createAuthService, createCsrfToken, hashToken } from "@bulletin/domain/auth";
import { displayNameSkeleton } from "@bulletin/domain/member";
import { dismissAnnouncement, listDismissedAnnouncementIds } from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authIssuer, staffOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import {
  createStaffApi,
  STAFF_ROUTES,
  type StaffApi,
  type StaffRoute,
} from "../../apps/staff-api/src/api.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const ISSUER = authIssuer();
const STAFF_ORIGIN = staffOrigin();
const STAFF_CLIENT = "bulletin-staff";
const SESSION_SECRET = "test-session-secret";

interface Session {
  readonly cookie: string;
  readonly memberId: string;
  readonly sessionId: string;
}

interface Harness {
  readonly database: TestDatabase;
  readonly api: StaffApi;
  readonly auth: Awaited<ReturnType<typeof createAuthService>>;
  readonly sql: SQL;
  readonly admin: Session;
  readonly regular: Session;
  readonly close: () => Promise<void>;
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
      FROM core.groups g WHERE g.key = ${key}
    `;
  }

  return member.id;
}

async function createSession(database: TestDatabase, memberId: string): Promise<Session> {
  const token = crypto.randomUUID();
  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, last_auth_at)
    VALUES (${memberId}, 'staff', ${hashToken(token)}, now() + interval '12 hours', now())
    RETURNING id
  `) as Array<{ id: string }>;

  if (session === undefined) {
    throw new Error("Could not create staff session");
  }

  return { cookie: token, memberId, sessionId: session.id };
}

async function createHarness(database: TestDatabase): Promise<Harness> {
  await runSeeds({
    sql: database.sql,
    registry: new SeedRegistry([
      baseSeedModule,
      flagsSeedModule,
      permissionFixtureSeedModule,
      groupsSeedModule,
      membersSeedModule,
      emoticonSeedModule,
      themesSeedModule,
    ]),
  });
  const adminId = await createMember(database, "Forum Admin", ["administrators"]);
  const regularId = await createMember(database, "Regular Staff Denied", ["members"]);
  const admin = await createSession(database, adminId);
  const regular = await createSession(database, regularId);
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

  return {
    database,
    api,
    auth,
    sql,
    admin,
    regular,
    close: async () => {
      await auth.close();
      await sql.close();
    },
  };
}

async function call(
  api: StaffApi,
  session: Session,
  routeId: string,
  body?: unknown,
): Promise<Response> {
  const route = STAFF_ROUTES.find((candidate) => candidate.id === routeId);

  if (route === undefined) {
    throw new Error(`No route ${routeId}`);
  }

  return callRoute(api, session, route, body);
}

async function callRoute(
  api: StaffApi,
  session: Session,
  route: StaffRoute,
  body?: unknown,
): Promise<Response> {
  return api.handle(
    new Request(`http://api.test${route.path}`, {
      method: route.method,
      headers: {
        cookie: `bl_staff=${session.cookie}`,
        origin: STAFF_ORIGIN,
        "x-bulletin-csrf": createCsrfToken(session.sessionId, SESSION_SECRET),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "staff_forums" }, async (database) => {
    const harness = await createHarness(database);

    try {
      await run(harness);
    } finally {
      await harness.close();
    }
  });
}

async function createForum(harness: Harness, body: Record<string, unknown>): Promise<string> {
  const response = await call(harness.api, harness.admin, "forums.mutate", {
    action: "create",
    ...body,
  });

  expect(response.status).toBe(200);
  const list = (await (await call(harness.api, harness.admin, "forums.list")).json()) as {
    forums: Array<{ id: string; title: string }>;
  };
  const forum = list.forums.find((candidate) => candidate.title === body.title);

  if (forum === undefined) {
    throw new Error(`Could not find created forum ${String(body.title)}`);
  }

  return forum.id;
}

integrationDescribe("staff forum structure", () => {
  test("denies the new screens without their ACP permissions", async () => {
    await withHarness(async (harness) => {
      for (const routeId of ["forums.list", "prefixes.list", "announcements.list"]) {
        expect((await call(harness.api, harness.regular, routeId)).status).toBe(403);
      }

      for (const routeId of ["forums.list", "prefixes.list", "announcements.list"]) {
        expect((await call(harness.api, harness.admin, routeId)).status).toBe(200);
      }
    });
  }, 30_000);

  test("creates, moves, reorders and deletes forums with sub-forums moving up", async () => {
    await withHarness(async (harness) => {
      const category = await createForum(harness, {
        title: "E2E Category",
        type: "category",
      });
      const parent = await createForum(harness, {
        title: "Parent Forum",
        type: "forum",
        parentId: category,
      });
      const child = await createForum(harness, {
        title: "Child Forum",
        type: "forum",
        parentId: parent,
      });

      await call(harness.api, harness.admin, "forums.mutate", {
        action: "move",
        id: child,
        parentId: category,
        position: 0,
      });

      const moved = (await (await call(harness.api, harness.admin, "forums.list")).json()) as {
        forums: Array<{ id: string; parentId: string | null; position: number; title: string }>;
      };

      expect(moved.forums.find((forum) => forum.id === child)?.parentId).toBe(category);
      expect(moved.forums.find((forum) => forum.id === child)?.position).toBe(0);

      const duplicate = await createForum(harness, {
        title: "Preserved Settings",
        type: "forum",
        parentId: parent,
      });
      await call(harness.api, harness.admin, "forums.mutate", {
        action: "settings",
        id: duplicate,
        description: "Kept after the move",
        rules: "",
        showModerators: true,
        language: "fr",
        defaultSort: "last_post",
        prefixMode: "none",
        prefixIds: [],
      });

      const beforeDelete = await call(harness.api, harness.admin, "forums.list");
      expect(beforeDelete.status).toBe(200);

      const deleted = await call(harness.api, harness.admin, "forums.mutate", {
        action: "delete",
        id: parent,
      });

      expect(deleted.status).toBe(200);

      const afterDelete = (await (
        await call(harness.api, harness.admin, "forums.list")
      ).json()) as {
        forums: Array<{
          id: string;
          parentId: string | null;
          description: string;
          language: string;
        }>;
      };
      const preserved = afterDelete.forums.find((forum) => forum.id === duplicate);

      expect(preserved?.parentId).toBe(category);
      expect(preserved?.description).toBe("Kept after the move");
      expect(preserved?.language).toBe("fr");
    });
  }, 30_000);

  test("rejects a move under a descendant and requires a topic choice when topics exist", async () => {
    await withHarness(async (harness) => {
      const category = await createForum(harness, {
        title: "Cycle Category",
        type: "category",
      });
      const parent = await createForum(harness, {
        title: "Cycle Parent",
        type: "forum",
        parentId: category,
      });
      const child = await createForum(harness, {
        title: "Cycle Child",
        type: "forum",
        parentId: parent,
      });
      const cycle = await call(harness.api, harness.admin, "forums.mutate", {
        action: "move",
        id: category,
        parentId: child,
        position: 0,
      });

      expect(cycle.status).toBe(400);

      await harness.database.sql`UPDATE core.forums SET topic_count = 2 WHERE id = ${parent}`;

      const noChoice = await call(harness.api, harness.admin, "forums.mutate", {
        action: "delete",
        id: parent,
      });
      expect(noChoice.status).toBe(409);

      const target = await createForum(harness, {
        title: "Topic Destination",
        type: "forum",
        parentId: category,
      });
      const moved = await call(harness.api, harness.admin, "forums.mutate", {
        action: "delete",
        id: parent,
        topicAction: "move",
        moveToForumId: target,
      });

      expect(moved.status).toBe(200);
    });
  }, 30_000);

  test("saves forum settings, prefixes and the required-prefix rule", async () => {
    await withHarness(async (harness) => {
      const forum = await createForum(harness, { title: "Settings Forum", type: "forum" });
      const prefixResponse = await call(harness.api, harness.admin, "prefixes.mutate", {
        action: "save",
        key: "solved",
        colour: "#1d9bf0",
        labels: { en: "Solved", es: "Resuelto", fr: "Résolu" },
        groupIds: [],
      });

      expect(prefixResponse.status).toBe(200);

      const prefixList = (await (
        await call(harness.api, harness.admin, "prefixes.list")
      ).json()) as {
        prefixes: Array<{ id: string; labels: Record<string, string | undefined> }>;
        groups: Array<{ id: string; key: string }>;
      };
      const prefix = prefixList.prefixes.find((candidate) => candidate.labels.en === "Solved");

      if (prefix === undefined) {
        throw new Error("Missing prefix");
      }

      const requiredWithoutPrefix = await call(harness.api, harness.admin, "forums.mutate", {
        action: "settings",
        id: forum,
        description: "Needs a prefix",
        rules: "Be nice",
        showModerators: false,
        language: "es",
        defaultSort: "start_date",
        prefixMode: "required",
        prefixIds: [],
      });

      expect(requiredWithoutPrefix.status).toBe(409);

      const saved = await call(harness.api, harness.admin, "forums.mutate", {
        action: "settings",
        id: forum,
        title: "Renamed Settings Forum",
        description: "Needs a prefix",
        rules: "Be nice",
        password: "forum-password",
        showModerators: false,
        language: "es",
        defaultSort: "start_date",
        prefixMode: "required",
        prefixIds: [prefix.id],
      });

      expect(saved.status).toBe(200);

      const list = (await (await call(harness.api, harness.admin, "forums.list")).json()) as {
        forums: Array<{
          id: string;
          title: string;
          description: string;
          rules: string;
          passwordProtected: boolean;
          showModerators: boolean;
          language: string;
          defaultSort: string;
          prefixMode: string;
          prefixIds: string[];
          slug: string;
        }>;
      };
      const row = list.forums.find((candidate) => candidate.id === forum);

      expect(row).toMatchObject({
        title: "Renamed Settings Forum",
        description: "Needs a prefix",
        rules: "Be nice",
        passwordProtected: true,
        showModerators: false,
        language: "es",
        defaultSort: "start_date",
        prefixMode: "required",
        prefixIds: [prefix.id],
        slug: "renamed-settings-forum",
      });

      const members = prefixList.groups.find(
        (group) => (group as { id: string; key?: string }).key === "members",
      );

      if (members === undefined) {
        throw new Error("Missing members group");
      }

      const updated = await call(harness.api, harness.admin, "prefixes.mutate", {
        action: "save",
        id: prefix.id,
        key: "solved",
        colour: "#a02a2a",
        labels: { en: "Answered", es: "Respondido", fr: "Répondu" },
        groupIds: [members.id],
      });
      expect(updated.status).toBe(200);

      const refreshed = (await (
        await call(harness.api, harness.admin, "prefixes.list")
      ).json()) as {
        prefixes: Array<{
          id: string;
          colour: string;
          labels: Record<string, string | undefined>;
          groupIds: string[];
        }>;
      };
      expect(refreshed.prefixes.find((candidate) => candidate.id === prefix.id)).toMatchObject({
        colour: "#a02a2a",
        labels: { en: "Answered", es: "Respondido", fr: "Répondu" },
        groupIds: [members.id],
      });

      const blocked = await call(harness.api, harness.admin, "prefixes.mutate", {
        action: "delete",
        id: prefix.id,
      });
      expect(blocked.status).toBe(409);

      const optional = await call(harness.api, harness.admin, "forums.mutate", {
        action: "settings",
        id: forum,
        description: "Needs a prefix",
        rules: "Be nice",
        showModerators: false,
        language: "es",
        defaultSort: "start_date",
        prefixMode: "optional",
        prefixIds: [],
      });
      expect(optional.status).toBe(200);

      const deleted = await call(harness.api, harness.admin, "prefixes.mutate", {
        action: "delete",
        id: prefix.id,
      });
      expect(deleted.status).toBe(200);
      const afterDelete = (await (
        await call(harness.api, harness.admin, "prefixes.list")
      ).json()) as {
        prefixes: Array<{ id: string }>;
      };
      expect(afterDelete.prefixes).toHaveLength(0);
    });
  }, 30_000);

  test("staff saves render emoticons, mentions, embeds and respect the content flags", async () => {
    await withHarness(async (harness) => {
      const forum = await createForum(harness, { title: "Rich Content Forum", type: "forum" });
      const body = [
        "Hi @Admin :smile:",
        "",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "",
        "https://example.com/article",
      ].join("\n");
      const startsAt = new Date(Date.now() - 60_000).toISOString();
      const saved = await call(harness.api, harness.admin, "announcements.mutate", {
        action: "save",
        title: "Rich content notice",
        body,
        scope: "forums",
        startsAt,
        dismissible: true,
        targets: [{ forumId: forum, includeSubforums: false }],
        groupIds: [],
      });

      expect(saved.status).toBe(200);

      const [announcement] = (await harness.database.sql`
        SELECT body_html FROM core.announcements WHERE title = 'Rich content notice'
      `) as Array<{ body_html: string }>;

      if (announcement === undefined) {
        throw new Error("Missing announcement");
      }

      expect(announcement.body_html).toContain('alt="Smile"');
      expect(announcement.body_html).toContain('class="emoticon"');
      expect(announcement.body_html).toContain('href="/profile/');
      expect(announcement.body_html).toContain('data-bl-embed="youtube"');
      expect(announcement.body_html).toContain(
        'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"',
      );
      expect(announcement.body_html).toContain("<bl-unfurl");

      const settings = await call(harness.api, harness.admin, "forums.mutate", {
        action: "settings",
        id: forum,
        rules: body,
        prefixIds: [],
      });

      expect(settings.status).toBe(200);

      const [rules] = (await harness.database.sql`
        SELECT rules_html FROM core.forums WHERE id = ${forum}
      `) as Array<{ rules_html: string }>;

      if (rules === undefined) {
        throw new Error("Missing forum rules");
      }

      expect(rules.rules_html).toContain('alt="Smile"');
      expect(rules.rules_html).toContain('href="/profile/');
      expect(rules.rules_html).toContain('data-bl-embed="youtube"');
      expect(rules.rules_html).toContain("<bl-unfurl");

      // Flags are evaluated for the author: turning them off reverts mentions and preview
      // cards to ordinary text and links, while emoticons and embeds stay core (ADR 0010).
      await harness.database.sql`
        UPDATE core.feature_flags SET default_value = false WHERE key IN ('mentions', 'unfurls')
      `;
      const plain = await call(harness.api, harness.admin, "forums.mutate", {
        action: "settings",
        id: forum,
        rules: body,
        prefixIds: [],
      });

      expect(plain.status).toBe(200);

      const [plainRules] = (await harness.database.sql`
        SELECT rules_html FROM core.forums WHERE id = ${forum}
      `) as Array<{ rules_html: string }>;

      if (plainRules === undefined) {
        throw new Error("Missing forum rules");
      }

      expect(plainRules.rules_html).toContain('alt="Smile"');
      expect(plainRules.rules_html).toContain('data-bl-embed="youtube"');
      expect(plainRules.rules_html).not.toContain('href="/profile/');
      expect(plainRules.rules_html).not.toContain("<bl-unfurl");
    });
  }, 30_000);

  test("creates, edits and deletes announcements with scope, schedule and targeting", async () => {
    await withHarness(async (harness) => {
      const forum = await createForum(harness, { title: "Announcement Forum", type: "forum" });
      const secondForum = await createForum(harness, {
        title: "Second Announcement Forum",
        type: "forum",
      });
      const groups = (await (
        await call(harness.api, harness.admin, "announcements.list")
      ).json()) as {
        groups: Array<{ id: string; key: string }>;
        forums: Array<{ id: string; title: string }>;
      };
      const vip = groups.groups.find((group) => group.key === "vip");

      if (vip === undefined) {
        throw new Error("Missing VIP group");
      }

      const startsAt = new Date(Date.now() - 60_000).toISOString();
      const endsAt = new Date(Date.now() + 86_400_000).toISOString();
      const created = await call(harness.api, harness.admin, "announcements.mutate", {
        action: "save",
        title: "Scheduled notice",
        body: "Visible only to VIP",
        scope: "forums",
        startsAt,
        endsAt,
        dismissible: true,
        targets: [
          { forumId: forum, includeSubforums: true },
          { forumId: secondForum, includeSubforums: false },
        ],
        groupIds: [vip.id],
      });

      expect(created.status).toBe(200);

      const list = (await (
        await call(harness.api, harness.admin, "announcements.list")
      ).json()) as {
        announcements: Array<{
          id: string;
          title: string;
          version: number;
          startsAt: string;
          endsAt: string | null;
          targets: Array<{ forumId: string; includeSubforums: boolean }>;
          groupIds: string[];
          dismissible: boolean;
        }>;
      };
      const announcement = list.announcements.find((row) => row.title === "Scheduled notice");

      if (announcement === undefined) {
        throw new Error("Missing announcement");
      }

      expect(announcement).toMatchObject({
        targets: [
          { forumId: forum, includeSubforums: true },
          { forumId: secondForum, includeSubforums: false },
        ],
        groupIds: [vip.id],
        dismissible: true,
      });
      expect(new Date(announcement.startsAt).toISOString()).toBe(startsAt);
      expect(
        announcement.endsAt === null ? null : new Date(announcement.endsAt).toISOString(),
      ).toBe(endsAt);

      const invalid = await call(harness.api, harness.admin, "announcements.mutate", {
        action: "save",
        title: "Bad schedule",
        body: "",
        scope: "global",
        startsAt: endsAt,
        endsAt: startsAt,
        dismissible: true,
        targets: [],
        groupIds: [],
      });
      expect(invalid.status).toBe(400);

      const edited = await call(harness.api, harness.admin, "announcements.mutate", {
        action: "save",
        id: announcement.id,
        title: "Scheduled notice",
        body: "Updated body",
        scope: "forums",
        startsAt,
        endsAt,
        dismissible: true,
        targets: [
          { forumId: forum, includeSubforums: true },
          { forumId: secondForum, includeSubforums: false },
        ],
        groupIds: [vip.id],
      });
      expect(edited.status).toBe(200);

      const afterEdit = (await (
        await call(harness.api, harness.admin, "announcements.list")
      ).json()) as {
        announcements: Array<{ id: string; version: number }>;
      };
      expect(afterEdit.announcements.find((row) => row.id === announcement.id)?.version).toBe(
        announcement.version + 1,
      );

      const deleted = await call(harness.api, harness.admin, "announcements.mutate", {
        action: "delete",
        id: announcement.id,
      });
      expect(deleted.status).toBe(200);
    });
  }, 30_000);

  test("dismissals survive edits only until the announcement content changes", async () => {
    await withHarness(async (harness) => {
      const [member] = (await harness.database.sql`
        SELECT id::text AS id FROM core.members WHERE display_name = 'Forum Admin'
      `) as Array<{ id: string }>;

      if (member === undefined) {
        throw new Error("Missing member");
      }

      const [announcement] = (await harness.database.sql`
        INSERT INTO core.announcements (title, body, scope, dismissible, starts_at)
        VALUES ('Dismiss me', 'First body', 'global', true, now() - interval '1 minute')
        RETURNING id::text AS id, version
      `) as Array<{ id: string; version: number }>;

      if (announcement === undefined) {
        throw new Error("Missing announcement");
      }

      expect(await dismissAnnouncement(harness.database.sql, member.id, announcement.id)).toBe(
        "ok",
      );
      expect(await listDismissedAnnouncementIds(harness.database.sql, member.id)).toContain(
        announcement.id,
      );

      await harness.database.sql`
        UPDATE core.announcements SET starts_at = now() - interval '1 day' WHERE id = ${announcement.id}
      `;
      expect(await listDismissedAnnouncementIds(harness.database.sql, member.id)).toContain(
        announcement.id,
      );

      await harness.database.sql`
        UPDATE core.announcements SET body = 'Second body' WHERE id = ${announcement.id}
      `;
      expect(await listDismissedAnnouncementIds(harness.database.sql, member.id)).not.toContain(
        announcement.id,
      );
    });
  }, 30_000);

  test("gates the announcement screens on the announcements flag", async () => {
    await withHarness(async (harness) => {
      expect((await call(harness.api, harness.admin, "announcements.list")).status).toBe(200);

      await harness.database.sql`
        UPDATE core.feature_flags SET default_value = false WHERE key = 'announcements'
      `;

      expect((await call(harness.api, harness.admin, "announcements.list")).status).toBe(404);
      expect(
        (
          await call(harness.api, harness.admin, "announcements.mutate", {
            action: "delete",
            id: "1",
          })
        ).status,
      ).toBe(404);
      const features = (await (await call(harness.api, harness.admin, "features.list")).json()) as {
        flags: Record<string, boolean>;
      };
      expect(features.flags.announcements).toBe(false);

      await harness.database.sql`
        UPDATE core.feature_flags SET default_value = true WHERE key = 'announcements'
      `;

      expect((await call(harness.api, harness.admin, "announcements.list")).status).toBe(200);
    });
  }, 30_000);
});
