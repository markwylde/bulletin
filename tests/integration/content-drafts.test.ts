import { describe, expect, test } from "bun:test";
import { createAuthService, createCsrfToken, hashToken } from "@bulletin/domain/auth";
import { deleteDraft, purgeExpiredDrafts, readDraft, saveDraft } from "@bulletin/domain/content";
import { suggestMembers } from "@bulletin/domain/member";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authIssuer, userOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import {
  draftDeleteResponse,
  draftGetResponse,
  draftSaveResponse,
  draftsRoute,
} from "../../apps/user-api/src/drafts.ts";
import { memberSuggestResponse } from "../../apps/user-api/src/members.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const CONTEXT = "reply:topic:1";
const SESSION_SECRET = "test-session-secret";

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "content_drafts" }, run);
}

async function createMember(
  database: TestDatabase,
  name: string,
  service = false,
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton, is_service)
    VALUES (${name}, ${name.toLowerCase().replace(/\s+/g, "")}, ${service})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error("Could not create member");
  }

  return member.id;
}

interface MemberSession {
  readonly memberId: string;
  readonly cookie: string;
  readonly csrf: string;
}

/** A live user session for the route tests; the token is the raw cookie value. */
async function createSession(database: TestDatabase, name: string): Promise<MemberSession> {
  const memberId = await createMember(database, name);
  const token = crypto.randomUUID();
  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, last_auth_at)
    VALUES (
      ${memberId}, 'user', ${hashToken(token)},
      now() + interval '12 hours', now()
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (session === undefined) {
    throw new Error("Could not create session");
  }

  return {
    memberId,
    cookie: `bl_session=${token}`,
    csrf: createCsrfToken(session.id, SESSION_SECRET),
  };
}

interface RouteOptions {
  readonly method?: "GET" | "PUT" | "DELETE";
  readonly contextKey?: string;
  readonly body?: unknown;
  readonly origin?: string | null;
  /** Overrides the session's token; `null` sends none. */
  readonly csrf?: string | null;
}

/**
 * Drives the real `/api/me/drafts` route through the auth service, so Origin and CSRF are
 * enforced exactly as in user-api (ADR 0018).
 */
async function callDraftsRoute(
  database: TestDatabase,
  auth: Awaited<ReturnType<typeof createAuthService>>,
  session: MemberSession | null,
  options: RouteOptions = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const url = new URL("http://api.test/api/me/drafts");

  if (options.contextKey !== undefined) {
    url.searchParams.set("contextKey", options.contextKey);
  }

  const headers = new Headers();

  if (options.origin !== null) {
    headers.set("origin", options.origin ?? userOrigin());
  }

  if (session !== null) {
    headers.set("cookie", session.cookie);
  }

  if (method === "PUT") {
    headers.set("content-type", "application/json");
  }

  const csrf = options.csrf === undefined ? session?.csrf : options.csrf;

  if (csrf !== null && csrf !== undefined) {
    headers.set("x-bulletin-csrf", csrf);
  }

  const response = await draftsRoute(
    auth,
    database.sql,
    new Request(url, {
      method,
      headers,
      ...(method === "PUT" ? { body: JSON.stringify(options.body ?? {}) } : {}),
    }),
  );

  if (response === null) {
    throw new Error("The drafts route did not match /api/me/drafts");
  }

  return response;
}

async function draftsAuth(database: TestDatabase) {
  const url = new URL(database.url);
  url.username = "user_api";
  url.password = "";
  const sql = new SQL(url.toString());

  try {
    const auth = await createAuthService({
      sql,
      kind: "user",
      issuer: authIssuer(),
      jwksUrl: "http://127.0.0.1:1/jwks.json",
      clientId: "bulletin-user",
      origin: userOrigin(),
      sessionSecret: SESSION_SECRET,
      nodeEnv: "test",
      cacheTtlMs: 0,
    });

    return {
      auth,
      close: async () => {
        await auth.close();
        await sql.close();
      },
    };
  } catch (error) {
    await sql.close();
    throw error;
  }
}

integrationDescribe("drafts and mention suggestions", () => {
  test("saves, reads, clears and expires a member draft", async () => {
    await withDb(async (database) => {
      const author = await createMember(database, "Draft Author");

      expect(await readDraft(database.sql, author, CONTEXT)).toBeNull();
      expect(await saveDraft(database.sql, author, CONTEXT, "A **draft**")).toMatchObject({
        contextKey: CONTEXT,
        bodyMd: "A **draft**",
      });
      expect((await readDraft(database.sql, author, CONTEXT))?.bodyMd).toBe("A **draft**");

      expect(await saveDraft(database.sql, author, CONTEXT, "   ")).toBeNull();
      expect(await readDraft(database.sql, author, CONTEXT)).toBeNull();

      await saveDraft(database.sql, author, CONTEXT, "old draft");
      await database.sql`
        UPDATE core.drafts SET updated_at = now() - interval '31 days'
        WHERE member_id = ${author}
      `;
      expect(await purgeExpiredDrafts(database.sql)).toBe(1);

      await saveDraft(database.sql, author, CONTEXT, "later");
      await deleteDraft(database.sql, author, CONTEXT);
      expect(await readDraft(database.sql, author, CONTEXT)).toBeNull();
    });
  });

  test("the API rejects invalid contexts and bodies", async () => {
    await withDb(async (database) => {
      const author = await createMember(database, "Api Author");

      const invalidContext = await draftGetResponse(
        database.sql,
        author,
        new URL("http://bulletin.localhost/api/me/drafts?contextKey=bad context"),
      );
      expect(invalidContext.status).toBe(400);

      const invalidBody = await draftSaveResponse(
        database.sql,
        author,
        new Request("http://bulletin.localhost/api/me/drafts", {
          method: "PUT",
          body: JSON.stringify({ contextKey: CONTEXT, bodyMd: 42 }),
        }),
      );
      expect(invalidBody.status).toBe(400);

      const saved = await draftSaveResponse(
        database.sql,
        author,
        new Request("http://bulletin.localhost/api/me/drafts", {
          method: "PUT",
          body: JSON.stringify({ contextKey: CONTEXT, bodyMd: "hello" }),
        }),
      );
      expect(saved.status).toBe(200);

      const loaded = await draftGetResponse(
        database.sql,
        author,
        new URL(`http://bulletin.localhost/api/me/drafts?contextKey=${CONTEXT}`),
      );
      expect(await loaded.json()).toMatchObject({ draft: { bodyMd: "hello" } });

      const deleted = await draftDeleteResponse(
        database.sql,
        author,
        new URL(`http://bulletin.localhost/api/me/drafts?contextKey=${CONTEXT}`),
      );
      expect(deleted.status).toBe(200);
      expect(await readDraft(database.sql, author, CONTEXT)).toBeNull();
    });
  });

  test("the drafts route requires authentication, Origin and CSRF", async () => {
    await withDb(async (database) => {
      const session = await createSession(database, "Route Author");
      const { auth, close } = await draftsAuth(database);

      try {
        for (const method of ["GET", "PUT", "DELETE"] as const) {
          const anonymous = await callDraftsRoute(database, auth, null, {
            method,
            contextKey: CONTEXT,
            ...(method === "PUT"
              ? { body: { contextKey: CONTEXT, bodyMd: "anonymous write" } }
              : {}),
          });
          expect(anonymous.status).toBe(401);
          expect(await anonymous.json()).toEqual({ code: "unauthenticated" });
        }

        const put = {
          method: "PUT" as const,
          contextKey: CONTEXT,
          body: { contextKey: CONTEXT, bodyMd: "route draft" },
        };

        const noOrigin = await callDraftsRoute(database, auth, session, {
          ...put,
          origin: null,
        });
        expect(noOrigin.status).toBe(403);
        expect(await noOrigin.json()).toEqual({ code: "invalid_origin" });

        const wrongOrigin = await callDraftsRoute(database, auth, session, {
          ...put,
          origin: "http://evil.test",
        });
        expect(wrongOrigin.status).toBe(403);
        expect(await wrongOrigin.json()).toEqual({ code: "invalid_origin" });

        const noCsrf = await callDraftsRoute(database, auth, session, { ...put, csrf: null });
        expect(noCsrf.status).toBe(403);
        expect(await noCsrf.json()).toEqual({ code: "invalid_csrf" });

        const wrongCsrf = await callDraftsRoute(database, auth, session, {
          ...put,
          csrf: "wrong-token",
        });
        expect(wrongCsrf.status).toBe(403);
        expect(await wrongCsrf.json()).toEqual({ code: "invalid_csrf" });

        // Every denial left the member's drafts untouched.
        expect(await readDraft(database.sql, session.memberId, CONTEXT)).toBeNull();

        const saved = await callDraftsRoute(database, auth, session, put);
        expect(saved.status).toBe(200);
        expect(await saved.json()).toMatchObject({ draft: { bodyMd: "route draft" } });
      } finally {
        await close();
      }
    });
  }, 20_000);

  test("the drafts route isolates members on read, write and delete", async () => {
    await withDb(async (database) => {
      const alice = await createSession(database, "Draft Alice");
      const bob = await createSession(database, "Draft Bob");
      const { auth, close } = await draftsAuth(database);

      try {
        const aliceSave = await callDraftsRoute(database, auth, alice, {
          method: "PUT",
          contextKey: CONTEXT,
          body: { contextKey: CONTEXT, bodyMd: "Alice's secret" },
        });
        expect(aliceSave.status).toBe(200);

        const bobRead = await callDraftsRoute(database, auth, bob, { contextKey: CONTEXT });
        expect(await bobRead.json()).toEqual({ draft: null });

        const bobSave = await callDraftsRoute(database, auth, bob, {
          method: "PUT",
          contextKey: CONTEXT,
          body: { contextKey: CONTEXT, bodyMd: "Bob's draft" },
        });
        expect(bobSave.status).toBe(200);

        const aliceRead = await callDraftsRoute(database, auth, alice, { contextKey: CONTEXT });
        expect(await aliceRead.json()).toMatchObject({ draft: { bodyMd: "Alice's secret" } });

        const bobReadAgain = await callDraftsRoute(database, auth, bob, { contextKey: CONTEXT });
        expect(await bobReadAgain.json()).toMatchObject({ draft: { bodyMd: "Bob's draft" } });

        const bobDelete = await callDraftsRoute(database, auth, bob, {
          method: "DELETE",
          contextKey: CONTEXT,
        });
        expect(bobDelete.status).toBe(200);
        expect(await readDraft(database.sql, bob.memberId, CONTEXT)).toBeNull();
        expect((await readDraft(database.sql, alice.memberId, CONTEXT))?.bodyMd).toBe(
          "Alice's secret",
        );

        const aliceAfterDelete = await callDraftsRoute(database, auth, alice, {
          contextKey: CONTEXT,
        });
        expect(await aliceAfterDelete.json()).toMatchObject({
          draft: { bodyMd: "Alice's secret" },
        });
      } finally {
        await close();
      }
    });
  }, 20_000);

  test("suggest returns up to eight prefix matches and never scans wildcards", async () => {
    await withDb(async (database) => {
      for (const name of [
        "Jo One",
        "Jo Two",
        "Jo Three",
        "Jo Four",
        "Jo Five",
        "Jo Six",
        "Jo Seven",
        "Jo Eight",
        "Jo Nine",
        "Alice",
      ]) {
        await createMember(database, name);
      }
      await createMember(database, "Jo Service", true);

      const members = await suggestMembers(database.sql, "jo");
      expect(members).toHaveLength(8);
      expect(members[0]?.displayName.startsWith("Jo")).toBe(true);
      expect(members[0]?.url).toMatch(/^\/profile\/\d+-jo-/);

      expect(await suggestMembers(database.sql, "%")).toEqual([]);
      const response = await memberSuggestResponse(
        database.sql,
        new URL("http://bulletin.localhost/api/members/suggest?q=jo"),
      );
      expect(((await response.json()) as { members: unknown[] }).members).toHaveLength(8);
    });
  });
});
