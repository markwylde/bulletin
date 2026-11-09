import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type ChallengeView,
  createAuthRouter,
  createCsrfToken,
  createSessionStore,
  hashToken,
  type SessionView,
} from "@bulletin/domain/auth";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import { exportJWK, generateKeyPair, type KeyInput, SignJWT } from "jose";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const ISSUER = "http://auth.bulletin.localhost:8080";
const USER_ORIGIN = "http://bulletin.localhost:8080";
const STAFF_ORIGIN = "http://staff.bulletin.localhost:8080";
const USER_CLIENT = "bulletin-user";
const STAFF_CLIENT = "bulletin-staff";
const SESSION_SECRET = "test-session-secret";
const ACTOR_IP = "203.0.113.42";

let privateKey: KeyInput;
let jwksServer: ReturnType<typeof Bun.serve>;
let jwksUrl = "";

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

function routerFor(
  sql: SQL,
  kind: "user" | "staff",
  options: {
    readonly bootstrapAdmins?: readonly { readonly issuer: string; readonly sub: string }[];
  } = {},
) {
  return createAuthRouter({
    sql,
    kind,
    issuer: ISSUER,
    jwksUrl,
    clientId: kind === "user" ? USER_CLIENT : STAFF_CLIENT,
    origin: kind === "user" ? USER_ORIGIN : STAFF_ORIGIN,
    sessionSecret: SESSION_SECRET,
    nodeEnv: "test",
    ...(options.bootstrapAdmins === undefined ? {} : { bootstrapAdmins: options.bootstrapAdmins }),
  });
}

function cookieValue(response: Response, name: string): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0] ?? "";
    const separator = pair.indexOf("=");

    if (separator > 0 && pair.slice(0, separator) === name) {
      return pair.slice(separator + 1);
    }
  }

  return undefined;
}

interface CallOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly cookie?: string;
  readonly origin?: string | null;
  readonly headers?: Record<string, string>;
}

async function call(
  router: (request: Request) => Promise<Response | null>,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);

  if (options.origin !== null) {
    headers.set("origin", options.origin ?? USER_ORIGIN);
  }

  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }

  const response = await router(
    new Request(`http://api.test${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

  if (response === null) {
    throw new Error(`Router did not handle ${path}`);
  }

  return response;
}

async function signToken(options: {
  readonly sub: string;
  readonly nonce: string;
  readonly clientId?: string;
  readonly issuer?: string;
  readonly email?: string;
  readonly name?: string;
  readonly expiresIn?: string;
}): Promise<string> {
  const payload: Record<string, unknown> = { nonce: options.nonce };

  if (options.email !== undefined) {
    payload.email = options.email;
  }

  if (options.name !== undefined) {
    payload.name = options.name;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.clientId ?? USER_CLIENT)
    .setSubject(options.sub)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(privateKey);
}

async function challenge(
  router: (request: Request) => Promise<Response | null>,
  origin = USER_ORIGIN,
): Promise<{ readonly view: ChallengeView; readonly cookie: string }> {
  const response = await call(router, "/api/auth/challenge", { body: {}, origin });
  expect(response.status).toBe(200);
  const view = (await response.json()) as ChallengeView;
  const id = cookieValue(response, "bl_login");

  if (id === undefined) {
    throw new Error("challenge cookie missing");
  }

  return { view, cookie: `bl_login=${id}` };
}

async function groupsFor(
  database: TestDatabase,
  sub: string,
): Promise<Array<{ key: string; is_primary: boolean }>> {
  return (await database.sql`
    SELECT g.key, mg.is_primary
    FROM core.member_groups mg
    JOIN core.groups g ON g.id = mg.group_id
    JOIN pii.identities i ON i.member_id = mg.member_id
    WHERE i.sub = ${sub}
    ORDER BY g.key
  `) as Array<{ key: string; is_primary: boolean }>;
}

async function loginMember(
  database: TestDatabase,
  router: (request: Request) => Promise<Response | null>,
  sub: string,
): Promise<{ readonly memberId: string }> {
  const started = await challenge(router);
  const idToken = await signToken({ sub, nonce: started.view.nonce });
  const response = await call(router, "/api/auth/session", {
    body: { idToken },
    cookie: started.cookie,
  });
  expect(response.status).toBe(200);

  const [row] = (await database.sql`
    SELECT member_id FROM core.sessions ORDER BY id DESC LIMIT 1
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error("session row missing");
  }

  return { memberId: row.member_id };
}

integrationDescribe("login flow", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    jwksServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({
          keys: [{ ...publicJwk, kid: "test-key", alg: "EdDSA", use: "sig" }],
        });
      },
    });
    jwksUrl = `http://127.0.0.1:${jwksServer.port}/.well-known/jwks.json`;
  });

  afterAll(() => {
    jwksServer.stop(true);
  });

  test("creates a session for a verified ID token and stores only its hash", async () => {
    await withDb("auth_login_success", async (database) => {
      const sql = new SQL(roleUrl(database.url, "user_api"));
      const router = routerFor(sql, "user");

      try {
        const started = await challenge(router);
        const idToken = await signToken({
          sub: "member-1",
          nonce: started.view.nonce,
          email: "member-1@example.test",
          name: "Regular Member One",
        });
        const response = await call(router, "/api/auth/session", {
          body: { idToken },
          cookie: started.cookie,
          headers: { "x-forwarded-for": ACTOR_IP, "user-agent": "Mozilla/5.0 Chrome/120" },
        });

        expect(response.status).toBe(200);
        const view = (await response.json()) as SessionView;
        expect(view).toMatchObject({
          authenticated: true,
          kind: "user",
          displayName: null,
          displayNameRequired: true,
        });
        expect(view.csrfToken).toBeString();

        const sessionToken = cookieValue(response, "bl_session");
        expect(sessionToken).toBeString();
        expect(cookieValue(response, "bl_login")).toBe("");

        const sessions = (await database.sql`
          SELECT s.id, s.member_id, s.kind, encode(s.token_hash, 'hex') AS token_hash,
                 s.reauth_at > now() AS has_reauth_window,
                 m.display_name
          FROM core.sessions s
          JOIN core.members m ON m.id = s.member_id
        `) as Array<{
          id: string;
          member_id: string;
          kind: string;
          token_hash: string;
          has_reauth_window: boolean;
          display_name: string | null;
        }>;

        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ kind: "user", display_name: null });
        expect(sessions[0]?.token_hash).toBe(
          createHash("sha256")
            .update(sessionToken ?? "")
            .digest("hex"),
        );
        expect(sessions[0]?.has_reauth_window).toBe(true);

        const readResponse = await call(router, "/api/auth/session", {
          cookie: `bl_session=${sessionToken ?? ""}`,
        });
        expect(readResponse.status).toBe(200);
        const readView = (await readResponse.json()) as SessionView;
        expect(readView).toMatchObject({
          authenticated: true,
          kind: "user",
          displayName: null,
          displayNameRequired: true,
        });
        expect(readView.csrfToken).toBe(createCsrfToken(sessions[0]?.id ?? "", SESSION_SECRET));

        const identities = (await database.sql`
          SELECT issuer, sub, email, idp_name FROM pii.identities
        `) as Array<{ issuer: string; sub: string; email: string; idp_name: string }>;

        expect(identities).toEqual([
          {
            issuer: ISSUER,
            sub: "member-1",
            email: "member-1@example.test",
            idp_name: "Regular Member One",
          },
        ]);

        const meta = (await database.sql`
          SELECT host(ip) AS ip, user_agent FROM pii.session_meta
        `) as Array<{ ip: string; user_agent: string }>;
        expect(meta).toEqual([{ ip: ACTOR_IP, user_agent: "Mozilla/5.0 Chrome/120" }]);

        const loginIps = (await database.sql`
          SELECT host(ip) AS ip FROM pii.ip_log
        `) as Array<{ ip: string }>;
        expect(loginIps).toEqual([{ ip: ACTOR_IP }]);
      } finally {
        await sql.close();
      }
    });
  }, 20_000);

  test("rejects a replayed token and creates no second session", async () => {
    await withDb("auth_login_replay", async (database) => {
      const sql = new SQL(roleUrl(database.url, "user_api"));
      const router = routerFor(sql, "user");

      try {
        const started = await challenge(router);
        const idToken = await signToken({ sub: "member-2", nonce: started.view.nonce });

        expect(
          (
            await call(router, "/api/auth/session", {
              body: { idToken },
              cookie: started.cookie,
            })
          ).status,
        ).toBe(200);

        const replay = await call(router, "/api/auth/session", {
          body: { idToken },
          cookie: started.cookie,
        });
        expect(replay.status).toBe(401);
        expect(cookieValue(replay, "bl_session")).toBeUndefined();

        const [{ count }] = (await database.sql`
          SELECT count(*)::int AS count FROM core.sessions
        `) as Array<{ count: number }>;
        expect(count).toBe(1);

        const [{ used }] = (await database.sql`
          SELECT used_at IS NOT NULL AS used FROM core.login_challenges
        `) as Array<{ used: boolean }>;
        expect(used).toBe(true);
      } finally {
        await sql.close();
      }
    });
  }, 20_000);

  test("rejects a token whose nonce belongs to another challenge", async () => {
    await withDb("auth_login_csrf", async (database) => {
      const sql = new SQL(roleUrl(database.url, "user_api"));
      const router = routerFor(sql, "user");

      try {
        const victim = await challenge(router);
        const attacker = await challenge(router);
        const attackerToken = await signToken({ sub: "attacker", nonce: attacker.view.nonce });

        const crossed = await call(router, "/api/auth/session", {
          body: { idToken: attackerToken },
          cookie: victim.cookie,
        });
        expect(crossed.status).toBe(401);
        expect(cookieValue(crossed, "bl_session")).toBeUndefined();

        const missingCookie = await call(router, "/api/auth/session", {
          body: { idToken: attackerToken },
        });
        expect(missingCookie.status).toBe(401);

        const [row] = (await database.sql`
          SELECT count(*)::int AS sessions FROM core.sessions
        `) as Array<{ sessions: number }>;
        expect(row?.sessions).toBe(0);
      } finally {
        await sql.close();
      }
    });
  }, 20_000);

  test("checks the Origin header on both login endpoints", async () => {
    await withDb("auth_login_origin", async (database) => {
      const sql = new SQL(roleUrl(database.url, "user_api"));
      const router = routerFor(sql, "user");

      try {
        const challengeResponse = await call(router, "/api/auth/challenge", {
          body: {},
          origin: "http://evil.test",
        });
        expect(challengeResponse.status).toBe(403);

        const sessionResponse = await call(router, "/api/auth/session", {
          body: { idToken: "irrelevant" },
          origin: "http://evil.test",
        });
        expect(sessionResponse.status).toBe(403);
      } finally {
        await sql.close();
      }
    });
  }, 20_000);

  test("keeps user and staff sessions separate", async () => {
    await withDb("auth_login_boundary", async (database) => {
      const userSql = new SQL(roleUrl(database.url, "user_api"));
      const staffSql = new SQL(roleUrl(database.url, "staff_api"));
      const userRouter = routerFor(userSql, "user");
      const staffRouter = routerFor(staffSql, "staff", {
        bootstrapAdmins: [{ issuer: ISSUER, sub: "admin" }],
      });

      try {
        const staffChallenge = await challenge(staffRouter, STAFF_ORIGIN);
        const staffToken = await signToken({
          sub: "admin",
          nonce: staffChallenge.view.nonce,
          clientId: STAFF_CLIENT,
        });
        const staffSession = await call(staffRouter, "/api/auth/session", {
          body: { idToken: staffToken },
          cookie: staffChallenge.cookie,
          origin: STAFF_ORIGIN,
        });
        expect(staffSession.status).toBe(200);
        const staffCookie = cookieValue(staffSession, "bl_staff");
        expect(staffCookie).toBeString();

        const viaWrongName = await call(userRouter, "/api/auth/session", {
          cookie: `bl_staff=${staffCookie}`,
        });
        expect(((await viaWrongName.json()) as SessionView).authenticated).toBe(false);

        const viaRightName = await call(userRouter, "/api/auth/session", {
          cookie: `bl_session=${staffCookie}`,
        });
        expect(((await viaRightName.json()) as SessionView).authenticated).toBe(false);

        const onStaffOrigin = await call(staffRouter, "/api/auth/session", {
          cookie: `bl_staff=${staffCookie}`,
        });
        expect(((await onStaffOrigin.json()) as SessionView).authenticated).toBe(true);
      } finally {
        await userSql.close();
        await staffSql.close();
      }
    });
  }, 20_000);

  test("treats a DarkAuth bearer token without a session cookie as a guest", async () => {
    await withDb("auth_login_bearer", async (database) => {
      const sql = new SQL(roleUrl(database.url, "user_api"));
      const router = routerFor(sql, "user");

      try {
        const started = await challenge(router);
        const idToken = await signToken({ sub: "bearer-user", nonce: started.view.nonce });
        const response = await call(router, "/api/auth/session", {
          headers: { authorization: `Bearer ${idToken}` },
        });

        expect(response.status).toBe(200);
        expect(((await response.json()) as SessionView).authenticated).toBe(false);
      } finally {
        await sql.close();
      }
    });
  }, 20_000);

  test("rejects a token for the other client audience", async () => {
    await withDb("auth_login_audience", async (database) => {
      const sql = new SQL(roleUrl(database.url, "user_api"));
      const router = routerFor(sql, "user");

      try {
        const started = await challenge(router);
        const staffAudienceToken = await signToken({
          sub: "cross-client",
          nonce: started.view.nonce,
          clientId: STAFF_CLIENT,
        });
        const response = await call(router, "/api/auth/session", {
          body: { idToken: staffAudienceToken },
          cookie: started.cookie,
        });
        expect(response.status).toBe(401);
      } finally {
        await sql.close();
      }
    });
  }, 20_000);

  test("creates the member in Members on first login and reuses it on return", async () => {
    await withDb("auth_member_first", async (database) => {
      const sql = new SQL(roleUrl(database.url, "user_api"));
      const router = routerFor(sql, "user");

      try {
        const first = await loginMember(database, router, "regular-first");
        const firstGroups = await groupsFor(database, "regular-first");
        expect(firstGroups).toEqual([{ key: "members", is_primary: true }]);

        const second = await loginMember(database, router, "regular-first");
        expect(second.memberId).toBe(first.memberId);
        expect(await groupsFor(database, "regular-first")).toEqual(firstGroups);

        const [members] = (await database.sql`
          SELECT count(*)::int AS count FROM core.members
        `) as Array<{ count: number }>;
        expect(members?.count).toBe(1);

        const [sessions] = (await database.sql`
          SELECT count(*)::int AS count FROM core.sessions
        `) as Array<{ count: number }>;
        expect(sessions?.count).toBe(2);
      } finally {
        await sql.close();
      }
    });
  }, 20_000);

  test("places configured bootstrap admins in Administrators and Members", async () => {
    await withDb("auth_member_bootstrap", async (database) => {
      const sql = new SQL(roleUrl(database.url, "user_api"));
      const router = routerFor(sql, "user", {
        bootstrapAdmins: [{ issuer: ISSUER, sub: "admin" }],
      });

      try {
        const admin = await loginMember(database, router, "admin");
        expect(admin.memberId).toBeString();
        expect(await groupsFor(database, "admin")).toEqual([
          { key: "administrators", is_primary: true },
          { key: "members", is_primary: false },
        ]);

        await loginMember(database, router, "not-an-admin");
        expect(await groupsFor(database, "not-an-admin")).toEqual([
          { key: "members", is_primary: true },
        ]);
      } finally {
        await sql.close();
      }
    });
  }, 20_000);

  test("expires user sessions after 30 days idle or 90 days absolute", async () => {
    await withDb("auth_lifetime_user", async (database) => {
      const sql = new SQL(roleUrl(database.url, "user_api"));
      const router = routerFor(sql, "user");

      async function loginCookie(sub: string): Promise<string> {
        const started = await challenge(router);
        const idToken = await signToken({ sub, nonce: started.view.nonce });
        const response = await call(router, "/api/auth/session", {
          body: { idToken },
          cookie: started.cookie,
        });
        expect(response.status).toBe(200);
        const cookie = cookieValue(response, "bl_session");

        if (cookie === undefined) {
          throw new Error("session cookie missing");
        }

        return cookie;
      }

      try {
        const idleCookie = await loginCookie("idle-user");
        await database.sql`
          UPDATE core.sessions SET last_seen_at = now() - interval '31 days'
          WHERE token_hash = ${hashToken(idleCookie)}
        `;
        const idle = await call(router, "/api/auth/session", {
          cookie: `bl_session=${idleCookie}`,
        });
        expect(((await idle.json()) as SessionView).authenticated).toBe(false);

        const absoluteCookie = await loginCookie("absolute-user");
        await database.sql`
          UPDATE core.sessions
          SET created_at = now() - interval '91 days', last_seen_at = now()
          WHERE token_hash = ${hashToken(absoluteCookie)}
        `;
        const absolute = await call(router, "/api/auth/session", {
          cookie: `bl_session=${absoluteCookie}`,
        });
        expect(((await absolute.json()) as SessionView).authenticated).toBe(false);
      } finally {
        await sql.close();
      }
    });
  }, 20_000);

  test("expires staff sessions after 2 hours idle or 12 hours absolute", async () => {
    await withDb("auth_lifetime_staff", async (database) => {
      const sql = new SQL(roleUrl(database.url, "staff_api"));
      const router = routerFor(sql, "staff", {
        bootstrapAdmins: [{ issuer: ISSUER, sub: "admin" }],
      });

      async function loginCookie(sub: string): Promise<string> {
        const started = await challenge(router, STAFF_ORIGIN);
        const idToken = await signToken({
          sub,
          nonce: started.view.nonce,
          clientId: STAFF_CLIENT,
        });
        const response = await call(router, "/api/auth/session", {
          body: { idToken },
          cookie: started.cookie,
          origin: STAFF_ORIGIN,
        });
        expect(response.status).toBe(200);
        const cookie = cookieValue(response, "bl_staff");

        if (cookie === undefined) {
          throw new Error("session cookie missing");
        }

        return cookie;
      }

      try {
        const idleCookie = await loginCookie("admin");
        await database.sql`
          UPDATE core.sessions SET last_seen_at = now() - interval '3 hours'
          WHERE token_hash = ${hashToken(idleCookie)}
        `;
        const idle = await call(router, "/api/auth/session", {
          cookie: `bl_staff=${idleCookie}`,
        });
        expect(((await idle.json()) as SessionView).authenticated).toBe(false);

        const absoluteCookie = await loginCookie("admin");
        await database.sql`
          UPDATE core.sessions
          SET created_at = now() - interval '13 hours', last_seen_at = now()
          WHERE token_hash = ${hashToken(absoluteCookie)}
        `;
        const absolute = await call(router, "/api/auth/session", {
          cookie: `bl_staff=${absoluteCookie}`,
        });
        expect(((await absolute.json()) as SessionView).authenticated).toBe(false);
      } finally {
        await sql.close();
      }
    });
  }, 20_000);

  test("caches sessions and clears them on session_revoked", async () => {
    await withDb("auth_session_cache", async (database) => {
      const [member] = (await database.sql`
        INSERT INTO core.members (display_name) VALUES ('Cache User') RETURNING id
      `) as Array<{ id: string }>;

      if (member === undefined) {
        throw new Error("member missing");
      }

      const token = "cache-token";
      const [session] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${member.id}, 'user', ${hashToken(token)}, now() + interval '24 hours')
        RETURNING id
      `) as Array<{ id: string }>;

      if (session === undefined) {
        throw new Error("session missing");
      }

      const sql = new SQL(roleUrl(database.url, "user_api"));
      const store = await createSessionStore({ sql, cacheTtlMs: 60_000 });

      try {
        expect(await store.find("user", token)).not.toBeNull();

        await database.sql`
          UPDATE core.sessions SET revoked_at = now() WHERE id = ${session.id}
        `;
        expect(await store.find("user", token)).not.toBeNull();

        await database.sql`SELECT pg_notify('session_revoked', ${session.id})`;
        let found = await store.find("user", token);

        for (let attempt = 0; attempt < 100 && found !== null; attempt += 1) {
          await Bun.sleep(20);
          found = await store.find("user", token);
        }

        expect(found).toBeNull();
      } finally {
        await store.close();
        await sql.close();
      }
    });
  }, 20_000);
});
