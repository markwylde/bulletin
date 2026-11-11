import { describe, expect, test } from "bun:test";
import { readFlagVersion } from "@bulletin/db/flags";
import { createAuthService, createCsrfToken, hashToken } from "@bulletin/domain/auth";
import { displayNameSkeleton } from "@bulletin/domain/member";
import { can, PERMISSION_KEYS } from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authIssuer, staffOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import { auditStaffLocaleChange } from "../../apps/staff-api/src/admin-log.ts";
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
    ON CONFLICT DO NOTHING
    RETURNING id
  `) as Array<{ id: string }>;
  const memberId =
    member?.id ??
    (
      (await database.sql`
      SELECT id FROM core.members WHERE name_skeleton = ${displayNameSkeleton(name)} LIMIT 1
    `) as Array<{ id: string }>
    )[0]?.id;

  if (memberId === undefined) {
    throw new Error(`Could not create member ${name}`);
  }

  for (const [index, key] of groups.entries()) {
    await database.sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      SELECT ${memberId}, g.id, ${index === 0}
      FROM core.groups g
      WHERE g.key = ${key}
      ON CONFLICT DO NOTHING
    `;
  }

  return memberId;
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
    onStaffLocaleChange: auditStaffLocaleChange,
  });
  const api = createStaffApi({
    auth,
    sql,
    checks: [
      {
        name: "database",
        async check() {
          await sql`SELECT 1`;
          return true;
        },
      },
      { name: "migrations", check: () => true },
    ],
  });

  return { api, auth, sql };
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

async function callRoute(
  api: StaffApi,
  route: StaffRoute,
  session: StaffSession,
  body?: unknown,
): Promise<Response> {
  return callPath(api, session, route.method, route.path, body);
}

function route(id: string): StaffRoute {
  const found = STAFF_ROUTES.find((candidate) => candidate.id === id);

  if (found === undefined) {
    throw new Error(`No route ${id}`);
  }

  return found;
}

integrationDescribe("staff API permission guard", () => {
  test("rejects every registered route for a member without acp.access", async () => {
    await withDb("staff_guard_denied", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const memberId = await createMember(database, "No ACP Member", ["members"]);
        const session = await createSession(database, memberId);

        for (const staffRoute of STAFF_ROUTES) {
          const response = await callRoute(
            api,
            staffRoute,
            session,
            staffRoute.id === "preferences.scheme" ? { scheme: "dark" } : undefined,
          );

          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({ code: "forbidden" });
        }

        const sessionResponse = await auth.handle(
          new Request("http://api.test/api/auth/session", {
            headers: { cookie: `bl_staff=${session.cookie}` },
          }),
        );
        expect(sessionResponse?.status).toBe(403);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("lets an administrator call every registered route", async () => {
    await withDb("staff_guard_admin", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const memberId = await createMember(database, "Staff Administrator", ["administrators"]);
        const session = await createSession(database, memberId);

        for (const staffRoute of STAFF_ROUTES) {
          const response = await callRoute(
            api,
            staffRoute,
            session,
            staffRoute.id === "preferences.scheme" ? { scheme: "dark" } : undefined,
          );

          expect(response.status).not.toBe(403);
        }
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("gives a super moderator member stats but no admin log or health data", async () => {
    await withDb("staff_guard_moderator", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const moderatorId = await createMember(database, "Panel Moderator", [
          "members",
          "super_moderators",
        ]);
        const moderator = await createSession(database, moderatorId);
        const adminId = await createMember(database, "Panel Administrator", ["administrators"]);
        const admin = await createSession(database, adminId);

        await database.sql`
          INSERT INTO core.admin_log (actor_member_id, action, target_type, target_id, summary)
          VALUES (
            ${adminId}, 'board.settings.update', 'board', 1,
            '{"before": {"board_name": "Old"}, "after": {"board_name": "New"}}'::jsonb
          )
        `;

        const members = await callRoute(api, route("dashboard.members"), moderator);
        expect(members.status).toBe(200);
        expect(await members.json()).toMatchObject({ total: expect.any(Number) });

        const topics = await callRoute(api, route("dashboard.topics"), moderator);
        expect(topics.status).toBe(200);
        expect(await topics.json()).toMatchObject({
          topics: expect.any(Number),
          posts: expect.any(Number),
          postsToday: expect.any(Number),
        });

        const plainMemberId = await createMember(database, "Plain Dashboard Member", ["members"]);
        const plainMember = await createSession(database, plainMemberId);
        const deniedTopics = await callRoute(api, route("dashboard.topics"), plainMember);
        expect(deniedTopics.status).toBe(403);

        const deniedLog = await callRoute(api, route("dashboard.log"), moderator);
        expect(deniedLog.status).toBe(403);
        expect(await deniedLog.json()).toEqual({ code: "forbidden" });

        const deniedHealth = await callRoute(api, route("dashboard.health"), moderator);
        expect(deniedHealth.status).toBe(403);
        expect(await deniedHealth.json()).toEqual({ code: "forbidden" });

        const adminLog = await callRoute(api, route("dashboard.log"), admin);
        expect(adminLog.status).toBe(200);
        const log = (await adminLog.json()) as { entries: Array<Record<string, unknown>> };
        expect(log.entries[0]).toMatchObject({
          actor: "Panel Administrator",
          action: "board.settings.update",
          targetType: "board",
        });

        const health = await callRoute(api, route("dashboard.health"), admin);
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({
          status: "ok",
          checks: { database: true, migrations: true },
        });
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("returns the session permissions and remembers the scheme", async () => {
    await withDb("staff_scheme", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const memberId = await createMember(database, "Scheme Owner", [
          "members",
          "super_moderators",
        ]);
        const session = await createSession(database, memberId);

        const readSession = async () => {
          const response = await auth.handle(
            new Request("http://api.test/api/auth/session", {
              headers: { cookie: `bl_staff=${session.cookie}` },
            }),
          );

          if (response === null) {
            throw new Error("session endpoint missing");
          }

          return (await response.json()) as {
            permissions: string[];
            scheme: string;
          };
        };

        const before = await readSession();
        expect(before.permissions).toEqual(["acp.access", "acp.members"]);
        expect(before.scheme).toBe("system");

        const saved = await callRoute(api, route("preferences.scheme"), session, {
          scheme: "dark",
        });
        expect(saved.status).toBe(200);
        expect(await saved.json()).toEqual({ scheme: "dark" });

        const after = await readSession();
        expect(after.scheme).toBe("dark");

        const [preference] = (await database.sql`
          SELECT
            summary->'before'->>'staffScheme' AS before_scheme,
            summary->'after'->>'staffScheme' AS after_scheme
          FROM core.admin_log
          WHERE action = 'staff.preferences.update'
          ORDER BY id DESC
          LIMIT 1
        `) as Array<{ before_scheme: string | null; after_scheme: string | null }>;

        expect(preference).toEqual({ before_scheme: "system", after_scheme: "dark" });

        const localeResponse = await auth.handle(
          new Request("http://api.test/api/me/locale", {
            method: "POST",
            headers: {
              cookie: `bl_staff=${session.cookie}`,
              origin: STAFF_ORIGIN,
              "x-bulletin-csrf": createCsrfToken(session.sessionId, SESSION_SECRET),
              "content-type": "application/json",
            },
            body: JSON.stringify({ locale: "fr" }),
          }),
        );
        expect(localeResponse?.status).toBe(200);

        const [localeEntry] = (await database.sql`
          SELECT
            summary->'before'->>'locale' AS before_locale,
            summary->'after'->>'locale' AS after_locale
          FROM core.admin_log
          WHERE action = 'staff.locale.update'
          ORDER BY id DESC
          LIMIT 1
        `) as Array<{ before_locale: string | null; after_locale: string | null }>;

        expect(localeEntry).toEqual({ before_locale: null, after_locale: "fr" });

        const invalid = await callRoute(api, route("preferences.scheme"), session, {
          scheme: "sepia",
        });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ code: "invalid_scheme" });
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("rejects an unknown method with 405 and keeps acp.access checks on it", async () => {
    await withDb("staff_guard_method", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const memberId = await createMember(database, "Method Member", ["members"]);
        const session = await createSession(database, memberId);
        const response = await api.handle(
          new Request("http://api.test/api/staff/dashboard/members", {
            method: "POST",
            headers: {
              cookie: `bl_staff=${session.cookie}`,
              origin: STAFF_ORIGIN,
              "x-bulletin-csrf": createCsrfToken(session.sessionId, SESSION_SECRET),
            },
          }),
        );
        expect(response.status).toBe(403);

        const adminId = await createMember(database, "Method Administrator", ["administrators"]);
        const admin = await createSession(database, adminId);
        const asAdmin = await api.handle(
          new Request("http://api.test/api/staff/dashboard/members", {
            method: "POST",
            headers: {
              cookie: `bl_staff=${admin.cookie}`,
              origin: STAFF_ORIGIN,
              "x-bulletin-csrf": createCsrfToken(admin.sessionId, SESSION_SECRET),
            },
          }),
        );
        expect(asAdmin.status).toBe(405);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("updates board settings, logs the change and denies a moderator", async () => {
    await withDb("staff_board_settings", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const adminId = await createMember(database, "Board Administrator", ["administrators"]);
        const admin = await createSession(database, adminId);
        const moderatorId = await createMember(database, "Board Moderator", [
          "members",
          "super_moderators",
        ]);
        const moderator = await createSession(database, moderatorId);

        const before = await callRoute(api, route("settings.board"), admin);
        expect(before.status).toBe(200);
        expect(await before.json()).toMatchObject({ boardName: "", offline: false });

        expect(await callRoute(api, route("settings.board"), moderator)).toHaveProperty(
          "status",
          403,
        );

        const saved = await callRoute(api, route("settings.board.update"), admin, {
          boardName: "New Board",
          boardDescription: "Welcome to the board",
          defaultLocale: "fr",
          offline: true,
          offlineMessage: "Down for maintenance",
        });
        expect(saved.status).toBe(200);
        expect(await saved.json()).toMatchObject({
          boardName: "New Board",
          defaultLocale: "fr",
          offline: true,
          offlineMessage: "Down for maintenance",
        });

        const denied = await callRoute(api, route("settings.board.update"), moderator, {
          boardName: "Denied",
          boardDescription: "",
          defaultLocale: "en",
          offline: false,
          offlineMessage: "",
        });
        expect(denied.status).toBe(403);

        const [entry] = (await database.sql`
          SELECT
            actor_member_id,
            action,
            summary->'before'->>'boardName' AS before_name,
            summary->'after'->>'boardName' AS after_name
          FROM core.admin_log
          WHERE action = 'board.settings.update'
          ORDER BY id DESC
          LIMIT 1
        `) as Array<{
          actor_member_id: string;
          action: string;
          before_name: string;
          after_name: string;
        }>;

        expect(entry).toMatchObject({
          actor_member_id: adminId,
          action: "board.settings.update",
          before_name: "",
          after_name: "New Board",
        });
        expect(await can(database.sql, adminId, "board.view_offline")).toBe(true);
        expect(await can(database.sql, moderatorId, "board.view_offline")).toBe(false);

        const today = new Date().toISOString().slice(0, 10);
        const filtered = await callPath(
          api,
          admin,
          "GET",
          `/api/staff/log?action=board.settings.update&actor=Board&from=${today}&to=${today}`,
        );
        expect(filtered.status).toBe(200);
        const log = (await filtered.json()) as { entries: Array<Record<string, unknown>> };
        expect(log.entries).toHaveLength(1);
        expect(log.entries[0]).toMatchObject({
          actor: "Board Administrator",
          action: "board.settings.update",
        });

        const empty = await callPath(
          api,
          admin,
          "GET",
          "/api/staff/log?actor=Nobody&action=board.settings.update",
        );
        expect(((await empty.json()) as { entries: unknown[] }).entries).toEqual([]);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("saves, lists and reverts string overrides with admin log entries", async () => {
    await withDb("staff_string_overrides", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const adminId = await createMember(database, "Strings Administrator", ["administrators"]);
        const admin = await createSession(database, adminId);
        const moderatorId = await createMember(database, "Strings Moderator", [
          "members",
          "super_moderators",
        ]);
        const moderator = await createSession(database, moderatorId);

        expect(await callRoute(api, route("i18n.keys"), moderator)).toHaveProperty("status", 403);

        const keys = await callPath(
          api,
          admin,
          "GET",
          "/api/staff/i18n/keys?query=user.placeholder",
        );
        expect(keys.status).toBe(200);
        const keyList = (await keys.json()) as {
          keys: Array<{ key: string; base: string; overrides: Record<string, string> }>;
        };
        expect(keyList.keys.map((entry) => entry.key)).toContain("user.placeholder.title");

        const saved = await callRoute(api, route("i18n.overrides.save"), admin, {
          key: "user.placeholder.title",
          values: { en: "Custom title", es: "Título propio", fr: "" },
        });
        expect(saved.status).toBe(200);
        expect(await saved.json()).toEqual({ ok: true });

        const active = await callRoute(api, route("i18n.overrides"), admin);
        const activeList = (await active.json()) as {
          overrides: Array<{ locale: string; key: string; value: string }>;
        };
        expect(activeList.overrides).toContainEqual(
          expect.objectContaining({
            locale: "en",
            key: "user.placeholder.title",
            value: "Custom title",
          }),
        );
        expect(activeList.overrides).toContainEqual(
          expect.objectContaining({
            locale: "es",
            key: "user.placeholder.title",
            value: "Título propio",
          }),
        );

        const invalid = await callRoute(api, route("i18n.overrides.save"), admin, {
          key: "user.placeholder.body",
          values: { en: "Hello {name}" },
        });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ code: "invalid_override" });

        const reverted = await callPath(
          api,
          admin,
          "DELETE",
          "/api/staff/i18n/overrides?locale=en&key=user.placeholder.title",
        );
        expect(reverted.status).toBe(200);
        expect(await reverted.json()).toEqual({ ok: true });

        const afterRevert = await callRoute(api, route("i18n.overrides"), admin);
        const afterList = (await afterRevert.json()) as {
          overrides: Array<{ locale: string }>;
        };
        expect(afterList.overrides.some((entry) => entry.locale === "en")).toBe(false);

        const actions = (await database.sql`
          SELECT action, summary->>'key' AS key
          FROM core.admin_log
          WHERE action IN ('i18n.override.update', 'i18n.override.revert')
          ORDER BY id
        `) as Array<{ action: string; key: string | null }>;
        expect(actions.map((entry) => entry.action)).toEqual([
          "i18n.override.update",
          "i18n.override.revert",
        ]);
        expect(actions[0]?.key).toBe("user.placeholder.title");
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("paginates the admin log beyond the first hundred entries", async () => {
    await withDb("staff_log_pagination", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const adminId = await createMember(database, "Pagination Administrator", [
          "administrators",
        ]);
        const admin = await createSession(database, adminId);

        await database.sql`
          INSERT INTO core.admin_log (actor_member_id, action, target_type, target_id, summary)
          SELECT ${adminId}, 'bulk.test', 'bulk', g, '{}'::jsonb
          FROM generate_series(1, 120) AS g
        `;

        const ids: string[] = [];
        let cursor: string | null = null;

        for (const expected of [50, 50, 20]) {
          const query = `/api/staff/log?action=bulk.test&limit=50${cursor === null ? "" : `&cursor=${cursor}`}`;
          const response = await callPath(api, admin, "GET", query);
          expect(response.status).toBe(200);
          const page = (await response.json()) as {
            entries: Array<{ id: string }>;
            nextCursor: string | null;
          };

          expect(page.entries).toHaveLength(expected);
          ids.push(...page.entries.map((entry) => entry.id));

          if (expected === 20) {
            expect(page.nextCursor).toBeNull();
          } else {
            expect(page.nextCursor).not.toBeNull();
          }

          cursor = page.nextCursor;
        }

        expect(new Set(ids).size).toBe(120);
        expect(BigInt(ids[0] ?? "0")).toBeGreaterThan(BigInt(ids[1] ?? "0"));
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("serializes concurrent scheme preferences before auditing", async () => {
    await withDb("staff_scheme_concurrent", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const adminId = await createMember(database, "Concurrent Scheme Admin", ["administrators"]);
        const admin = await createSession(database, adminId);

        const [first, second] = await Promise.all([
          callRoute(api, route("preferences.scheme"), admin, { scheme: "dark" }),
          callRoute(api, route("preferences.scheme"), admin, { scheme: "light" }),
        ]);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);

        const entries = (await database.sql`
          SELECT
            summary->'before'->>'staffScheme' AS before_scheme,
            summary->'after'->>'staffScheme' AS after_scheme
          FROM core.admin_log
          WHERE action = 'staff.preferences.update'
          ORDER BY id
        `) as Array<{ before_scheme: string | null; after_scheme: string | null }>;

        expect(entries).toHaveLength(2);
        expect(entries[0]?.before_scheme).toBe("system");
        expect(entries[1]?.before_scheme).toBe(entries[0]?.after_scheme);

        const [preference] = (await database.sql`
          SELECT staff_scheme FROM core.member_prefs WHERE member_id = ${adminId}
        `) as Array<{ staff_scheme: string }>;
        expect(preference?.staff_scheme).toBe(entries[1]?.after_scheme);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("serializes concurrent locale preferences before auditing", async () => {
    await withDb("staff_locale_concurrent", async (database) => {
      const { auth, sql } = await createStaffApiFor(database);

      try {
        const adminId = await createMember(database, "Concurrent Locale Admin", ["administrators"]);
        const admin = await createSession(database, adminId);
        const setLocale = (locale: string) =>
          auth.handle(
            new Request("http://api.test/api/me/locale", {
              method: "POST",
              headers: {
                cookie: `bl_staff=${admin.cookie}`,
                origin: STAFF_ORIGIN,
                "x-bulletin-csrf": createCsrfToken(admin.sessionId, SESSION_SECRET),
                "content-type": "application/json",
              },
              body: JSON.stringify({ locale }),
            }),
          );

        const [first, second] = await Promise.all([setLocale("es"), setLocale("fr")]);
        expect(first?.status).toBe(200);
        expect(second?.status).toBe(200);

        const entries = (await database.sql`
          SELECT
            summary->'before'->>'locale' AS before_locale,
            summary->'after'->>'locale' AS after_locale
          FROM core.admin_log
          WHERE action = 'staff.locale.update'
          ORDER BY id
        `) as Array<{ before_locale: string | null; after_locale: string | null }>;

        expect(entries).toHaveLength(2);
        expect(entries[0]?.before_locale).toBeNull();
        expect(entries[1]?.before_locale).toBe(entries[0]?.after_locale);

        const [member] = (await database.sql`
          SELECT locale FROM core.members WHERE id = ${adminId}
        `) as Array<{ locale: string | null }>;
        expect(member?.locale).toBe(entries[1]?.after_locale);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("serializes concurrent board updates so audit snapshots chain", async () => {
    await withDb("staff_board_concurrent", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const adminId = await createMember(database, "Concurrent Board Admin", ["administrators"]);
        const admin = await createSession(database, adminId);

        const [first, second] = await Promise.all([
          callRoute(api, route("settings.board.update"), admin, {
            boardName: "First Board",
            boardDescription: "",
            defaultLocale: "en",
            offline: false,
            offlineMessage: "",
          }),
          callRoute(api, route("settings.board.update"), admin, {
            boardName: "Second Board",
            boardDescription: "",
            defaultLocale: "en",
            offline: false,
            offlineMessage: "",
          }),
        ]);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);

        const entries = (await database.sql`
          SELECT
            summary->'before'->>'boardName' AS before_name,
            summary->'after'->>'boardName' AS after_name
          FROM core.admin_log
          WHERE action = 'board.settings.update'
          ORDER BY id
        `) as Array<{ before_name: string | null; after_name: string | null }>;

        expect(entries).toHaveLength(2);
        expect(entries[1]?.before_name).toBe(entries[0]?.after_name);

        const [board] = (await database.sql`
          SELECT board_name FROM core.board_settings WHERE id = 1
        `) as Array<{ board_name: string }>;
        expect(board?.board_name).toBe(entries[1]?.after_name);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("serializes concurrent overrides so audit snapshots chain", async () => {
    await withDb("staff_overrides_concurrent", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        const adminId = await createMember(database, "Concurrent Strings Admin", [
          "administrators",
        ]);
        const admin = await createSession(database, adminId);
        const key = "user.placeholder.title";

        const [first, second] = await Promise.all([
          callRoute(api, route("i18n.overrides.save"), admin, {
            key,
            values: { en: "First override" },
          }),
          callRoute(api, route("i18n.overrides.save"), admin, {
            key,
            values: { en: "Second override" },
          }),
        ]);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);

        const entries = (await database.sql`
          SELECT
            summary->'before'->>'en' AS before_en,
            summary->'after'->>'en' AS after_en
          FROM core.admin_log
          WHERE action = 'i18n.override.update'
          ORDER BY id
        `) as Array<{ before_en: string | null; after_en: string | null }>;

        expect(entries).toHaveLength(2);
        expect(entries[0]?.before_en).toBeNull();
        expect(entries[1]?.before_en).toBe(entries[0]?.after_en);

        const [override] = (await database.sql`
          SELECT value FROM core.string_overrides WHERE locale = 'en' AND key = ${key}
        `) as Array<{ value: string }>;
        expect(override?.value).toBe(entries[1]?.after_en);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);
});

integrationDescribe("staff flags", () => {
  async function seedFlags(database: TestDatabase): Promise<void> {
    await database.sql`
      INSERT INTO core.feature_flags (
        key, description, owner, default_value, affects_render, client_visible, rules,
        created_at, updated_at, fully_on_since
      )
      VALUES
        (
          'freshFlag', 'Changed this week.', 'core', false, false, true, '[]'::jsonb,
          now() - interval '3 days', now() - interval '3 days', NULL
        ),
        (
          'staleFlag', 'Fully on for over ninety days.', 'core', true, false, false,
          '[]'::jsonb, now() - interval '130 days', now() - interval '120 days',
          now() - interval '120 days'
        )
    `;
  }

  test("denies the flags routes to staff without acp.flags", async () => {
    await withDb("staff_flags_denied", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        await seedFlags(database);
        const moderatorId = await createMember(database, "Flags Moderator", [
          "members",
          "super_moderators",
        ]);
        const moderator = await createSession(database, moderatorId);

        for (const id of ["flags.list", "flags.log"]) {
          const response = await callRoute(api, route(id), moderator);
          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({ code: "forbidden" });
        }

        const deniedSave = await callRoute(api, route("flags.rules.update"), moderator, {
          key: "freshFlag",
          rules: [{ type: "group", groups: ["members"], value: true }],
        });
        expect(deniedSave.status).toBe(403);
        expect(await deniedSave.json()).toEqual({ code: "forbidden" });

        const [stored] = (await database.sql`
          SELECT rules FROM core.feature_flags WHERE key = 'freshFlag'
        `) as Array<{ rules: unknown }>;
        expect(stored?.rules).toEqual([]);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("lists flags with their age and highlights a fully on flag for removal", async () => {
    await withDb("staff_flags_list", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        await seedFlags(database);
        const adminId = await createMember(database, "Flags Administrator", ["administrators"]);
        const admin = await createSession(database, adminId);

        const response = await callRoute(api, route("flags.list"), admin);
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          flags: Array<{
            key: string;
            description: string;
            owner: string;
            defaultValue: boolean;
            rules: unknown[];
            ageDays: number;
            stale: boolean;
          }>;
        };

        expect(body.flags.map((flag) => flag.key)).toEqual(["freshFlag", "staleFlag"]);

        const stale = body.flags.find((flag) => flag.key === "staleFlag");
        expect(stale).toMatchObject({
          description: "Fully on for over ninety days.",
          owner: "core",
          defaultValue: true,
          rules: [],
          stale: true,
        });
        expect(stale?.ageDays).toBeGreaterThanOrEqual(129);

        const fresh = body.flags.find((flag) => flag.key === "freshFlag");
        expect(fresh).toMatchObject({ stale: false, ageDays: 3 });
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("saves ordered rules, bumps the cache tag and records before and after", async () => {
    await withDb("staff_flags_update", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        await seedFlags(database);
        const adminId = await createMember(database, "Flags Editor", ["administrators"]);
        const admin = await createSession(database, adminId);
        const rules = [
          { type: "group", groups: ["super_moderators"], value: true },
          { type: "percentage", percent: 50, value: true },
        ];

        expect(await readFlagVersion(database.sql)).toBe("0");

        const saved = await callRoute(api, route("flags.rules.update"), admin, {
          key: "staleFlag",
          rules,
        });
        expect(saved.status).toBe(200);
        const savedFlag = (await saved.json()) as {
          key: string;
          rules: unknown[];
          stale: boolean;
        };
        expect(savedFlag).toMatchObject({ key: "staleFlag", rules, stale: true });

        expect(await readFlagVersion(database.sql)).toBe("1");

        const [stored] = (await database.sql`
          SELECT rules FROM core.feature_flags WHERE key = 'staleFlag'
        `) as Array<{ rules: unknown }>;
        expect(stored?.rules).toEqual(rules);

        const [entry] = (await database.sql`
          SELECT actor_member_id, action, target_type, target_id, summary
          FROM core.admin_log
          WHERE action = 'flags.update'
          ORDER BY id DESC
          LIMIT 1
        `) as Array<{
          actor_member_id: string;
          action: string;
          target_type: string | null;
          target_id: string | null;
          summary: unknown;
        }>;
        expect(entry).toMatchObject({
          actor_member_id: adminId,
          action: "flags.update",
          target_type: "flag",
          target_id: null,
        });
        expect(entry?.summary).toEqual({
          key: "staleFlag",
          before: { rules: [] },
          after: { rules },
        });

        const log = await callRoute(api, route("flags.log"), admin);
        expect(log.status).toBe(200);
        const logBody = (await log.json()) as {
          entries: Array<{ actor: string | null; action: string; summary: unknown }>;
        };
        expect(logBody.entries[0]).toMatchObject({
          actor: "Flags Editor",
          action: "flags.update",
        });
        expect(logBody.entries[0]?.summary).toMatchObject({ key: "staleFlag" });

        const refreshed = await callRoute(api, route("flags.list"), admin);
        const list = (await refreshed.json()) as {
          flags: Array<{ key: string; rules: unknown[]; stale: boolean }>;
        };
        expect(list.flags.find((flag) => flag.key === "staleFlag")).toMatchObject({
          rules,
          stale: true,
        });
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("keeps the removal highlight across saves that stay fully on", async () => {
    await withDb("staff_flags_stale_save", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        await seedFlags(database);
        const adminId = await createMember(database, "Stale Flag Admin", ["administrators"]);
        const admin = await createSession(database, adminId);

        const readFullyOnSince = async (): Promise<string | null> => {
          const [row] = (await database.sql`
            SELECT fully_on_since FROM core.feature_flags WHERE key = 'staleFlag'
          `) as Array<{ fully_on_since: Date | string | null }>;

          return row?.fully_on_since === null || row?.fully_on_since === undefined
            ? null
            : new Date(row.fully_on_since).toISOString();
        };

        const originalSince = await readFullyOnSince();
        expect(originalSince).not.toBeNull();

        // An identical save keeps the flag fully on and must not reset the highlight.
        const identical = await callRoute(api, route("flags.rules.update"), admin, {
          key: "staleFlag",
          rules: [],
        });
        expect(identical.status).toBe(200);
        expect(await identical.json()).toMatchObject({ stale: true });
        expect(await readFullyOnSince()).toBe(originalSince);

        // An edit that keeps the flag fully enabled must not reset it either.
        const fullyOnRules = [{ type: "percentage", percent: 50, value: true }];
        const edited = await callRoute(api, route("flags.rules.update"), admin, {
          key: "staleFlag",
          rules: fullyOnRules,
        });
        expect(edited.status).toBe(200);
        expect(await edited.json()).toMatchObject({ stale: true });
        expect(await readFullyOnSince()).toBe(originalSince);

        // Turning the flag off clears the instant and the highlight.
        const off = await callRoute(api, route("flags.rules.update"), admin, {
          key: "staleFlag",
          rules: [{ type: "percentage", percent: 50, value: false }],
        });
        expect(off.status).toBe(200);
        expect(await off.json()).toMatchObject({ stale: false });
        expect(await readFullyOnSince()).toBeNull();

        // Becoming fully on again starts a new clock, so it is not immediately stale.
        const on = await callRoute(api, route("flags.rules.update"), admin, {
          key: "staleFlag",
          rules: fullyOnRules,
        });
        expect(on.status).toBe(200);
        expect(await on.json()).toMatchObject({ stale: false });

        const resetSince = await readFullyOnSince();
        expect(resetSince).not.toBeNull();
        expect(resetSince).not.toBe(originalSince);
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("rejects invalid rules and unknown flags without changing anything", async () => {
    await withDb("staff_flags_invalid", async (database) => {
      const { api, auth, sql } = await createStaffApiFor(database);

      try {
        await seedFlags(database);
        const adminId = await createMember(database, "Flags Validator", ["administrators"]);
        const admin = await createSession(database, adminId);

        const invalid = await callRoute(api, route("flags.rules.update"), admin, {
          key: "freshFlag",
          rules: [{ type: "percentage", percent: 150, value: true }],
        });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ code: "invalid_rules", fields: ["rule-0"] });

        const missingKey = await callRoute(api, route("flags.rules.update"), admin, {
          rules: [],
        });
        expect(missingKey.status).toBe(400);
        expect(await missingKey.json()).toEqual({ code: "invalid_request" });

        const unknown = await callRoute(api, route("flags.rules.update"), admin, {
          key: "noSuchFlag",
          rules: [],
        });
        expect(unknown.status).toBe(404);
        expect(await unknown.json()).toEqual({ code: "not_found" });

        const [stored] = (await database.sql`
          SELECT rules FROM core.feature_flags WHERE key = 'freshFlag'
        `) as Array<{ rules: unknown }>;
        expect(stored?.rules).toEqual([]);
        expect(await readFlagVersion(database.sql)).toBe("0");
      } finally {
        await auth.close();
        await sql.close();
      }
    });
  }, 30_000);
});

integrationDescribe("ACP permission catalog", () => {
  test("seeds every permission for administrators and the moderator subset", async () => {
    await withDb("staff_acp_seed", async ({ sql }) => {
      const rows = (await sql`
        SELECT g.key, s.key AS permission
        FROM core.group_settings s
        JOIN core.groups g ON g.id = s.group_id
        WHERE s.value = 'true'::jsonb
        ORDER BY g.key, s.key
      `) as Array<{ key: string; permission: string }>;

      const permissions = new Set<string>(PERMISSION_KEYS);

      expect(
        rows
          .filter((row) => row.key === "administrators" && permissions.has(row.permission))
          .map((row) => row.permission),
      ).toEqual([...PERMISSION_KEYS].sort());
      expect(
        rows
          .filter((row) => row.key === "super_moderators" && permissions.has(row.permission))
          .map((row) => row.permission),
      ).toEqual(["acp.access", "acp.members", "members.view_list"]);
      expect(
        rows.filter((row) => row.key === "members" && permissions.has(row.permission)),
      ).toEqual([{ key: "members", permission: "members.view_list" }]);
    });
  }, 30_000);
});
