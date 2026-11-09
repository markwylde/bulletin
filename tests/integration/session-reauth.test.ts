import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AuthService,
  type AuthServiceOptions,
  type ChallengeView,
  createAuthService,
  createCsrfToken,
  hashToken,
  type SessionView,
} from "@bulletin/domain/auth";
import { displayNameSkeleton, resolveMemberLocale } from "@bulletin/domain/member";
import { can } from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authIssuer, staffOrigin, userOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import { exportJWK, generateKeyPair, type KeyInput, SignJWT } from "jose";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const ISSUER = authIssuer();
const USER_ORIGIN = userOrigin();
const STAFF_ORIGIN = staffOrigin();
const USER_CLIENT = "bulletin-user";
const STAFF_CLIENT = "bulletin-staff";
const SESSION_SECRET = "test-session-secret";

let privateKey: KeyInput;
let jwksServer: ReturnType<typeof Bun.serve>;
let jwksUrl = "";
let tokenServer: ReturnType<typeof Bun.serve>;
let tokenUrl = "";
let pendingNonce = "";

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

async function call(
  service: AuthService,
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly cookie?: string;
    readonly origin?: string | null;
    readonly headers?: Record<string, string>;
  } = {},
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

  const response = await service.handle(
    new Request(`http://api.test${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

  if (response === null) {
    throw new Error(`Service did not handle ${path}`);
  }

  return response;
}

async function signToken(options: {
  readonly sub: string;
  readonly nonce: string;
  readonly email?: string;
  readonly name?: string;
  readonly clientId?: string;
  readonly authTime?: number;
  /** `null` omits the exp claim entirely. */
  readonly expiresIn?: string | null;
}): Promise<string> {
  const payload: Record<string, unknown> = { nonce: options.nonce };

  if (options.email !== undefined) {
    payload.email = options.email;
  }

  if (options.name !== undefined) {
    payload.name = options.name;
  }

  if (options.authTime !== undefined) {
    payload.auth_time = options.authTime;
  }

  const token = new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(options.clientId ?? USER_CLIENT)
    .setSubject(options.sub)
    .setIssuedAt();

  if (options.expiresIn !== null) {
    token.setExpirationTime(options.expiresIn ?? "5m");
  }

  return token.sign(privateKey);
}

async function login(
  service: AuthService,
  sub: string,
  kind: "user" | "staff" = "user",
  options: { readonly authTime?: number } = {},
): Promise<string> {
  const origin = kind === "staff" ? STAFF_ORIGIN : USER_ORIGIN;
  const clientId = kind === "staff" ? STAFF_CLIENT : USER_CLIENT;
  const cookieName = kind === "staff" ? "bl_staff" : "bl_session";
  const challengeResponse = await call(service, "/api/auth/challenge", {
    body: {},
    origin,
  });
  expect(challengeResponse.status).toBe(200);
  const challenge = (await challengeResponse.json()) as ChallengeView;
  const challengeCookie = cookieValue(challengeResponse, "bl_login");

  if (challengeCookie === undefined) {
    throw new Error("challenge cookie missing");
  }

  const response = await call(service, "/api/auth/session", {
    body: {
      idToken: await signToken({
        sub,
        nonce: challenge.nonce,
        clientId,
        ...(options.authTime === undefined ? {} : { authTime: options.authTime }),
      }),
    },
    cookie: `bl_login=${challengeCookie}`,
    origin,
  });
  expect(response.status).toBe(200);
  const sessionCookie = cookieValue(response, cookieName);

  if (sessionCookie === undefined) {
    throw new Error("session cookie missing");
  }

  return sessionCookie;
}

async function csrfFor(
  service: AuthService,
  sessionCookie: string,
  kind: "user" | "staff" = "user",
): Promise<string> {
  const cookieName = kind === "staff" ? "bl_staff" : "bl_session";
  const response = await call(service, "/api/auth/session", {
    cookie: `${cookieName}=${sessionCookie}`,
  });
  const view = (await response.json()) as SessionView;

  if (view.csrfToken === null) {
    throw new Error("CSRF token missing");
  }

  return view.csrfToken;
}

async function memberIdFor(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`member ${sub} missing`);
  }

  return row.member_id;
}

async function createMemberWithIdentity(
  database: TestDatabase,
  sub: string,
  name: string,
): Promise<string> {
  const skeleton = displayNameSkeleton(name);
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${skeleton})
    ON CONFLICT DO NOTHING
    RETURNING id
  `) as Array<{ id: string }>;
  const memberId =
    member?.id ??
    (
      (await database.sql`
      SELECT id FROM core.members WHERE name_skeleton = ${skeleton} LIMIT 1
    `) as Array<{ id: string }>
    )[0]?.id;

  if (memberId === undefined) {
    throw new Error(`member ${sub} could not be created`);
  }

  await database.sql`
    INSERT INTO pii.identities (member_id, issuer, sub, email, idp_name)
    VALUES (
      ${memberId}, ${ISSUER}, ${sub},
      ${`${sub}@bulletin.test`}, ${name}
    )
    ON CONFLICT (issuer, sub) DO NOTHING
  `;

  return memberId;
}

/** A staff session for a member that does not have `acp.access`, for denial tests. */
async function directStaffSession(
  database: TestDatabase,
  sub: string,
  name: string,
): Promise<{ readonly cookie: string; readonly memberId: string; readonly sessionId: string }> {
  const memberId = await createMemberWithIdentity(database, sub, name);
  const token = crypto.randomUUID();

  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, last_auth_at)
    VALUES (
      ${memberId}, 'staff', ${hashToken(token)},
      now() + interval '12 hours', now() - interval '1 hour'
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (session === undefined) {
    throw new Error(`staff session for ${sub} could not be created`);
  }

  return { cookie: token, memberId, sessionId: session.id };
}

async function directUserSession(
  database: TestDatabase,
  sub: string,
  name: string,
): Promise<{ readonly cookie: string; readonly memberId: string; readonly sessionId: string }> {
  const memberId = await createMemberWithIdentity(database, sub, name);
  const token = crypto.randomUUID();

  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, last_auth_at)
    VALUES (
      ${memberId}, 'user', ${hashToken(token)},
      now() - interval '25 hours', now()
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (session === undefined) {
    throw new Error(`user session for ${sub} could not be created`);
  }

  return { cookie: token, memberId, sessionId: session.id };
}

/** Drives the refresh redirect and its callback through the real service handlers. */
async function silentReauth(
  service: AuthService,
  sessionCookie: string,
): Promise<{ readonly refresh: Response; readonly redirect: URL; readonly callback: Response }> {
  const refresh = await call(service, "/api/auth/refresh?return_to=%2Ftopic%2F12-welcome", {
    cookie: `bl_session=${sessionCookie}`,
    origin: null,
  });
  expect(refresh.status).toBe(303);
  const redirect = new URL(refresh.headers.get("location") ?? "");
  expect(redirect.searchParams.get("prompt")).toBe("none");
  pendingNonce = redirect.searchParams.get("nonce") ?? "";
  const state = redirect.searchParams.get("state") ?? "";
  const challengeCookie = cookieValue(refresh, "bl_login");

  if (challengeCookie === undefined) {
    throw new Error("refresh challenge cookie missing");
  }

  const callback = await call(
    service,
    `/api/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
    { cookie: `bl_login=${challengeCookie}`, origin: null },
  );

  return { refresh, redirect, callback };
}

integrationDescribe("silent re-auth and background grace", () => {
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
    tokenServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        await request.text();
        return Response.json({
          id_token: await signToken({ sub: "silent-user", nonce: pendingNonce }),
          access_token: "unused",
        });
      },
    });
    tokenUrl = `http://127.0.0.1:${tokenServer.port}/token`;
  });

  afterAll(() => {
    jwksServer.stop(true);
    tokenServer.stop(true);
  });

  async function serviceFor(
    database: TestDatabase,
    overrides: Partial<AuthServiceOptions> = {},
  ): Promise<{ service: AuthService; sql: SQL }> {
    const sql = new SQL(roleUrl(database.url, "user_api"));
    const service = await createAuthService({
      sql,
      kind: "user",
      issuer: ISSUER,
      jwksUrl,
      tokenUrl,
      clientId: USER_CLIENT,
      origin: USER_ORIGIN,
      sessionSecret: SESSION_SECRET,
      nodeEnv: "test",
      testEndpoints: true,
      cacheTtlMs: 0,
      ...overrides,
    });

    return { service, sql };
  }

  async function staffServiceFor(
    database: TestDatabase,
  ): Promise<{ service: AuthService; sql: SQL }> {
    const sql = new SQL(roleUrl(database.url, "staff_api"));
    const service = await createAuthService({
      sql,
      kind: "staff",
      issuer: ISSUER,
      jwksUrl,
      tokenUrl,
      clientId: STAFF_CLIENT,
      origin: STAFF_ORIGIN,
      sessionSecret: SESSION_SECRET,
      nodeEnv: "test",
      testEndpoints: true,
      cacheTtlMs: 0,
      bootstrapAdmins: [{ issuer: ISSUER, sub: "admin" }],
    });

    return { service, sql };
  }

  test("allows background requests within two hours and rejects them after", async () => {
    await withDb("auth_reauth_grace", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const sessionCookie = await login(service, "grace-user");

        await database.sql`
          UPDATE core.sessions SET reauth_at = now() - interval '30 minutes'
          WHERE member_id = (SELECT member_id FROM pii.identities WHERE sub = 'grace-user')
        `;
        const within = await call(service, "/api/test/protected", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(within.status).toBe(200);
        expect(await within.json()).toMatchObject({ ok: true, kind: "user" });

        const sessionWithin = await call(service, "/api/auth/session", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(sessionWithin.status).toBe(200);
        expect(await sessionWithin.json()).toMatchObject({ authenticated: true });

        await database.sql`
          UPDATE core.sessions SET reauth_at = now() - interval '3 hours'
          WHERE member_id = (SELECT member_id FROM pii.identities WHERE sub = 'grace-user')
        `;
        const after = await call(service, "/api/test/protected", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(after.status).toBe(401);
        expect(await after.json()).toEqual({ code: "reauth_required" });

        const sessionAfter = await call(service, "/api/auth/session", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(sessionAfter.status).toBe(401);
        expect(await sessionAfter.json()).toMatchObject({
          code: "reauth_required",
          csrfToken: expect.any(String),
          kind: "user",
        });
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("rejects an ID token without an exp claim", async () => {
    await withDb("auth_missing_exp", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const challengeResponse = await call(service, "/api/auth/challenge", { body: {} });
        expect(challengeResponse.status).toBe(200);
        const challenge = (await challengeResponse.json()) as ChallengeView;
        const challengeCookie = cookieValue(challengeResponse, "bl_login");

        const response = await call(service, "/api/auth/session", {
          body: {
            idToken: await signToken({
              sub: "no-expiry",
              nonce: challenge.nonce,
              expiresIn: null,
            }),
          },
          cookie: `bl_login=${challengeCookie ?? ""}`,
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ code: "invalid_token" });
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("completes silent re-auth and extends reauth_at", async () => {
    await withDb("auth_reauth_success", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const sessionCookie = await login(service, "silent-user");
        await database.sql`
          UPDATE core.sessions SET reauth_at = now() - interval '25 hours'
          WHERE member_id = (SELECT member_id FROM pii.identities WHERE sub = 'silent-user')
        `;

        const { redirect, callback } = await silentReauth(service, sessionCookie);

        expect(redirect.searchParams.get("client_id")).toBe(USER_CLIENT);
        expect(redirect.searchParams.get("redirect_uri")).toBe(`${USER_ORIGIN}/api/auth/callback`);
        expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");

        expect(callback.status).toBe(303);
        expect(callback.headers.get("location")).toBe("/topic/12-welcome");
        expect(cookieValue(callback, "bl_login")).toBe("");

        const [session] = (await database.sql`
          SELECT s.reauth_at > now() + interval '23 hours' AS extended,
                 s.revoked_at
          FROM core.sessions s
          JOIN pii.identities i ON i.member_id = s.member_id
          WHERE i.sub = 'silent-user'
        `) as Array<{ extended: boolean; revoked_at: Date | null }>;
        expect(session).toEqual({ extended: true, revoked_at: null });

        const [challenge] = (await database.sql`
          SELECT used_at IS NOT NULL AS used FROM core.login_challenges ORDER BY id DESC LIMIT 1
        `) as Array<{ used: boolean }>;
        expect(challenge?.used).toBe(true);

        const read = await call(service, "/api/auth/session", {
          cookie: `bl_session=${sessionCookie}`,
        });
        const view = (await read.json()) as SessionView;
        expect(view.authenticated).toBe(true);
        expect(Date.parse(view.reauthAt ?? "")).toBeGreaterThan(Date.now());
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("extends reauth by one hour for an identity-provider outage, up to three times", async () => {
    await withDb("auth_outage", async (database) => {
      const { service, sql } = await serviceFor(database, {
        oidcFetch: async () => {
          throw new TypeError("fetch failed");
        },
      });

      try {
        const sessionCookie = await login(service, "outage-user");
        await database.sql`
          UPDATE core.sessions SET reauth_at = now() - interval '25 hours'
          WHERE member_id = (SELECT member_id FROM pii.identities WHERE sub = 'outage-user')
        `;

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const { callback } = await silentReauth(service, sessionCookie);
          expect(callback.status).toBe(303);
          expect(callback.headers.get("location")).toBe("/topic/12-welcome");

          const [row] = (await database.sql`
            SELECT s.reauth_retry_count,
                   s.reauth_at > now() + interval '50 minutes' AS extended,
                   s.revoked_at
            FROM core.sessions s
            JOIN pii.identities i ON i.member_id = s.member_id
            WHERE i.sub = 'outage-user'
          `) as Array<{
            reauth_retry_count: number;
            extended: boolean;
            revoked_at: Date | null;
          }>;
          expect(row).toEqual({
            reauth_retry_count: attempt,
            extended: true,
            revoked_at: null,
          });
        }

        const fourth = await silentReauth(service, sessionCookie);
        expect(fourth.callback.status).toBe(303);
        expect(fourth.callback.headers.get("location")).toBe("/topic/12-welcome?auth_error=1");

        const [revoked] = (await database.sql`
          SELECT s.revoked_at
          FROM core.sessions s
          JOIN pii.identities i ON i.member_id = s.member_id
          WHERE i.sub = 'outage-user'
        `) as Array<{ revoked_at: Date | null }>;
        expect(revoked?.revoked_at).not.toBeNull();

        const read = await call(service, "/api/auth/session", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(((await read.json()) as SessionView).authenticated).toBe(false);
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("treats a 5xx token response as an outage", async () => {
    await withDb("auth_outage_5xx", async (database) => {
      const { service, sql } = await serviceFor(database, {
        oidcFetch: async () => new Response("unavailable", { status: 503 }),
      });

      try {
        const sessionCookie = await login(service, "outage-5xx");
        await database.sql`
          UPDATE core.sessions SET reauth_at = now() - interval '25 hours'
          WHERE member_id = (SELECT member_id FROM pii.identities WHERE sub = 'outage-5xx')
        `;

        const { callback } = await silentReauth(service, sessionCookie);
        expect(callback.status).toBe(303);
        expect(callback.headers.get("location")).toBe("/topic/12-welcome");

        const [row] = (await database.sql`
          SELECT reauth_retry_count, revoked_at
          FROM core.sessions s
          JOIN pii.identities i ON i.member_id = s.member_id
          WHERE i.sub = 'outage-5xx'
        `) as Array<{ reauth_retry_count: number; revoked_at: Date | null }>;
        expect(row).toEqual({ reauth_retry_count: 1, revoked_at: null });
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("applies the outage grace when the JWKS endpoint is unreachable", async () => {
    await withDb("auth_outage_jwks", async (database) => {
      const { service, sql } = await serviceFor(database, {
        jwksUrl: "http://127.0.0.1:1/.well-known/jwks.json",
      });

      try {
        const session = await directUserSession(database, "jwks-outage", "Jwks Outage");
        const { callback } = await silentReauth(service, session.cookie);

        expect(callback.status).toBe(303);
        expect(callback.headers.get("location")).toBe("/topic/12-welcome");

        const [row] = (await database.sql`
          SELECT reauth_retry_count, reauth_at > now() + interval '50 minutes' AS extended
          FROM core.sessions WHERE id = ${session.sessionId}
        `) as Array<{ reauth_retry_count: number; extended: boolean }>;
        expect(row).toEqual({ reauth_retry_count: 1, extended: true });
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 30_000);

  test("revokes the session when the identity provider denies re-auth", async () => {
    await withDb("auth_reauth_disabled", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const sessionCookie = await login(service, "disabled-user");
        await database.sql`
          UPDATE core.sessions SET reauth_at = now() - interval '25 hours'
          WHERE member_id = (SELECT member_id FROM pii.identities WHERE sub = 'disabled-user')
        `;

        const refresh = await call(service, "/api/auth/refresh?return_to=%2F", {
          cookie: `bl_session=${sessionCookie}`,
          origin: null,
        });
        expect(refresh.status).toBe(303);
        const state =
          new URL(refresh.headers.get("location") ?? "").searchParams.get("state") ?? "";
        const challengeCookie = cookieValue(refresh, "bl_login");

        const callback = await call(
          service,
          `/api/auth/callback?error=login_required&state=${encodeURIComponent(state)}`,
          { cookie: `bl_login=${challengeCookie}`, origin: null },
        );
        expect(callback.status).toBe(303);
        expect(callback.headers.get("location")).toBe("/?auth_error=1");
        expect(cookieValue(callback, "bl_session")).toBe("");

        const [session] = (await database.sql`
          SELECT revoked_at FROM core.sessions s
          JOIN pii.identities i ON i.member_id = s.member_id
          WHERE i.sub = 'disabled-user'
        `) as Array<{ revoked_at: Date | null }>;
        expect(session?.revoked_at).not.toBeNull();

        const after = await call(service, "/api/test/protected", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(after.status).toBe(401);
        expect(await after.json()).toEqual({ code: "unauthenticated" });
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("returns to the page as a guest when there is no session to refresh", async () => {
    await withDb("auth_reauth_guest", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const response = await call(service, "/api/auth/refresh?return_to=%2Ftopic%2F3", {
          origin: null,
        });
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/topic/3?auth_error=1");
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("rotates a promoted member's session on the next response with a 60 s old-token overlap", async () => {
    await withDb("auth_rotation", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const firstLogin = await login(service, "rotate-user");
        const secondLogin = await login(service, "rotate-user");
        expect(secondLogin).not.toBe(firstLogin);

        const [row] = (await database.sql`
          SELECT s.id, s.member_id
          FROM core.sessions s
          JOIN pii.identities i ON i.member_id = s.member_id
          WHERE i.sub = 'rotate-user'
          ORDER BY s.id
          LIMIT 1
        `) as Array<{ id: string; member_id: string }>;

        if (row === undefined) {
          throw new Error("session missing");
        }

        await database.sql.begin(async (tx) => {
          await tx`
            UPDATE core.member_groups SET is_primary = false
            WHERE member_id = ${row.member_id}
          `;
          await tx`
            INSERT INTO core.member_groups (member_id, group_id, is_primary)
            SELECT ${row.member_id}, id, true
            FROM core.groups WHERE key = 'administrators'
          `;
        });

        const rotated = await call(service, "/api/auth/session", {
          cookie: `bl_session=${firstLogin}`,
        });
        expect(rotated.status).toBe(200);
        const newCookie = cookieValue(rotated, "bl_session");
        expect(newCookie).toBeString();
        expect(newCookie).not.toBe(firstLogin);

        const oldWithinOverlap = await call(service, "/api/test/protected", {
          cookie: `bl_session=${firstLogin}`,
        });
        expect(oldWithinOverlap.status).toBe(200);

        const replacement = await call(service, "/api/test/protected", {
          cookie: `bl_session=${newCookie ?? ""}`,
        });
        expect(replacement.status).toBe(200);

        await database.sql`
          UPDATE core.sessions
          SET previous_token_expires_at = now() - interval '1 second'
          WHERE id = ${row.id}
        `;
        const oldAfterOverlap = await call(service, "/api/test/protected", {
          cookie: `bl_session=${firstLogin}`,
        });
        expect(oldAfterOverlap.status).toBe(401);
        expect(await oldAfterOverlap.json()).toEqual({ code: "unauthenticated" });
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("logout revokes the session and clears the cookie", async () => {
    await withDb("auth_logout", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const sessionCookie = await login(service, "logout-user");
        const csrfToken = await csrfFor(service, sessionCookie);

        const missing = await call(service, "/api/auth/logout", {
          method: "POST",
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(missing.status).toBe(403);
        expect(await missing.json()).toEqual({ code: "invalid_csrf" });

        const response = await call(service, "/api/auth/logout", {
          method: "POST",
          cookie: `bl_session=${sessionCookie}`,
          headers: { "x-bulletin-csrf": csrfToken },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ code: "logged_out", clearLocalData: true });
        expect(cookieValue(response, "bl_session")).toBe("");

        const read = await call(service, "/api/auth/session", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(((await read.json()) as SessionView).authenticated).toBe(false);

        const [session] = (await database.sql`
          SELECT s.revoked_at
          FROM core.sessions s
          JOIN pii.identities i ON i.member_id = s.member_id
          WHERE i.sub = 'logout-user'
        `) as Array<{ revoked_at: Date | null }>;
        expect(session?.revoked_at).not.toBeNull();
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("logout still revokes after the re-auth grace expires", async () => {
    await withDb("auth_logout_grace", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const sessionCookie = await login(service, "logout-grace");
        const before = await call(service, "/api/auth/session", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(before.status).toBe(200);
        const beforeView = (await before.json()) as SessionView;
        expect(beforeView.csrfToken).toBeString();

        await database.sql`
          UPDATE core.sessions SET reauth_at = now() - interval '3 hours'
          WHERE member_id = (SELECT member_id FROM pii.identities WHERE sub = 'logout-grace')
        `;

        const afterGrace = await call(service, "/api/auth/session", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(afterGrace.status).toBe(401);
        const afterGraceBody = (await afterGrace.json()) as {
          code: string;
          csrfToken: string;
        };
        expect(afterGraceBody.code).toBe("reauth_required");
        expect(afterGraceBody.csrfToken).toBeString();

        const loggedOut = await call(service, "/api/auth/logout", {
          method: "POST",
          cookie: `bl_session=${sessionCookie}`,
          headers: { "x-bulletin-csrf": afterGraceBody.csrfToken },
        });
        expect(loggedOut.status).toBe(200);
        expect(await loggedOut.json()).toEqual({
          code: "logged_out",
          clearLocalData: true,
        });

        const read = await call(service, "/api/auth/session", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(((await read.json()) as SessionView).authenticated).toBe(false);

        const [session] = (await database.sql`
          SELECT s.revoked_at
          FROM core.sessions s
          JOIN pii.identities i ON i.member_id = s.member_id
          WHERE i.sub = 'logout-grace'
        `) as Array<{ revoked_at: Date | null }>;
        expect(session?.revoked_at).not.toBeNull();
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("lets an administrator revoke a member's sessions but denies a member without acp.access", async () => {
    await withDb("auth_revoke_all", async (database) => {
      const { service, sql } = await staffServiceFor(database);

      try {
        const adminCookie = await login(service, "admin", "staff");
        const adminCsrf = await csrfFor(service, adminCookie, "staff");
        const target = await directStaffSession(database, "target-member", "Target Member");
        const regular = await directStaffSession(database, "regular-staff", "Regular Staff");
        const regularCsrf = createCsrfToken(regular.sessionId, SESSION_SECRET);

        const denied = await call(
          service,
          `/api/staff/members/${target.memberId}/sessions/revoke`,
          {
            method: "POST",
            cookie: `bl_staff=${regular.cookie}`,
            origin: STAFF_ORIGIN,
            headers: { "x-bulletin-csrf": regularCsrf },
          },
        );
        expect(denied.status).toBe(403);
        expect(await denied.json()).toEqual({ code: "forbidden" });

        const [stillThere] = (await database.sql`
          SELECT revoked_at FROM core.sessions WHERE id = ${target.sessionId}
        `) as Array<{ revoked_at: Date | null }>;
        expect(stillThere?.revoked_at).toBeNull();

        const revoked = await call(
          service,
          `/api/staff/members/${target.memberId}/sessions/revoke`,
          {
            method: "POST",
            cookie: `bl_staff=${adminCookie}`,
            origin: STAFF_ORIGIN,
            headers: { "x-bulletin-csrf": adminCsrf },
          },
        );
        expect(revoked.status).toBe(200);
        expect(await revoked.json()).toEqual({ revoked: 1 });

        const after = await call(service, "/api/auth/session", {
          cookie: `bl_staff=${target.cookie}`,
        });
        expect(((await after.json()) as SessionView).authenticated).toBe(false);
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("denies staff sessions to members without acp.access", async () => {
    await withDb("auth_staff_acp", async (database) => {
      const { service, sql } = await staffServiceFor(database);

      try {
        for (const sub of ["member-1", "banned-member"]) {
          const challengeResponse = await call(service, "/api/auth/challenge", {
            body: {},
            origin: STAFF_ORIGIN,
          });
          expect(challengeResponse.status).toBe(200);
          const challenge = (await challengeResponse.json()) as ChallengeView;
          const challengeCookie = cookieValue(challengeResponse, "bl_login");

          const response = await call(service, "/api/auth/session", {
            body: {
              idToken: await signToken({
                sub,
                nonce: challenge.nonce,
                clientId: STAFF_CLIENT,
              }),
            },
            cookie: `bl_login=${challengeCookie ?? ""}`,
            origin: STAFF_ORIGIN,
          });
          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({ code: "forbidden" });
          expect(cookieValue(response, "bl_staff")).toBeUndefined();
        }

        const adminCookie = await login(service, "admin", "staff");
        expect(adminCookie).toBeString();
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("ordinary login with an old or absent auth_time requires step-up", async () => {
    await withDb("auth_stale_login", async (database) => {
      const { service, sql } = await staffServiceFor(database);

      try {
        const oldTime = Math.floor(Date.now() / 1_000) - 2 * 60 * 60;
        const oldCookie = await login(service, "admin", "staff", { authTime: oldTime });
        const oldSensitive = await call(service, "/api/test/sensitive", {
          cookie: `bl_staff=${oldCookie}`,
        });
        expect(oldSensitive.status).toBe(401);
        expect(await oldSensitive.json()).toEqual({ code: "step_up_required" });

        const [oldSession] = (await database.sql`
          SELECT now() - last_auth_at > interval '1 hour' AS stale
          FROM core.sessions
          WHERE token_hash = ${hashToken(oldCookie)}
        `) as Array<{ stale: boolean }>;
        expect(oldSession?.stale).toBe(true);

        const absentCookie = await login(service, "admin", "staff");
        const absentSensitive = await call(service, "/api/test/sensitive", {
          cookie: `bl_staff=${absentCookie}`,
        });
        expect(absentSensitive.status).toBe(401);
        expect(await absentSensitive.json()).toEqual({ code: "step_up_required" });
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("grants acp and staff actions only to administrators in this change", async () => {
    await withDb("auth_permission_seam", async (database) => {
      const { service, sql } = await staffServiceFor(database);

      try {
        await login(service, "admin", "staff");
        const adminId = await memberIdFor(database, "admin");
        const regular = await directStaffSession(database, "regular-perms", "Regular Perms");

        expect(await can(database.sql, adminId, "acp.access")).toBe(true);
        expect(await can(database.sql, regular.memberId, "acp.access")).toBe(false);
        expect(await can(database.sql, adminId, "sessions.revoke")).toBe(true);
        expect(await can(database.sql, regular.memberId, "sessions.revoke")).toBe(false);
        expect(await can(database.sql, adminId, "members.view_name_history")).toBe(true);
        expect(await can(database.sql, regular.memberId, "members.view_name_history")).toBe(false);
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("marks sessions for rotation on membership insert, update and delete", async () => {
    await withDb("auth_group_rotation_trigger", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        await login(service, "trigger-user");
        const memberId = await memberIdFor(database, "trigger-user");
        const [session] = (await database.sql`
          SELECT id FROM core.sessions WHERE member_id = ${memberId}
        `) as Array<{ id: string }>;

        if (session === undefined) {
          throw new Error("session missing");
        }

        const banned = (await database.sql`
          SELECT id FROM core.groups WHERE key = 'banned'
        `) as Array<{ id: string }>;
        const bannedId = banned[0]?.id;

        if (bannedId === undefined) {
          throw new Error("banned group missing");
        }

        await database.sql`
          INSERT INTO core.member_groups (member_id, group_id, is_primary)
          VALUES (${memberId}, ${bannedId}, false)
        `;
        const [inserted] = (await database.sql`
          SELECT rotate_pending FROM core.sessions WHERE id = ${session.id}
        `) as Array<{ rotate_pending: boolean }>;
        expect(inserted?.rotate_pending).toBe(true);

        await database.sql`
          UPDATE core.sessions SET rotate_pending = false WHERE id = ${session.id}
        `;
        await database.sql`
          DELETE FROM core.member_groups
          WHERE member_id = ${memberId} AND group_id = ${bannedId}
        `;
        const [deleted] = (await database.sql`
          SELECT rotate_pending FROM core.sessions WHERE id = ${session.id}
        `) as Array<{ rotate_pending: boolean }>;
        expect(deleted?.rotate_pending).toBe(true);

        await database.sql`
          UPDATE core.sessions SET rotate_pending = false WHERE id = ${session.id}
        `;
        await database.sql`
          UPDATE core.member_groups SET is_primary = is_primary WHERE member_id = ${memberId}
        `;
        const [updated] = (await database.sql`
          SELECT rotate_pending FROM core.sessions WHERE id = ${session.id}
        `) as Array<{ rotate_pending: boolean }>;
        expect(updated?.rotate_pending).toBe(true);
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("requires and completes a staff step-up with a fresh auth_time", async () => {
    await withDb("auth_step_up", async (database) => {
      const { service, sql } = await staffServiceFor(database);

      try {
        const adminCookie = await login(service, "admin", "staff");
        await database.sql`
          UPDATE core.sessions SET last_auth_at = now() - interval '20 minutes'
          WHERE member_id = (SELECT member_id FROM pii.identities WHERE sub = 'admin')
        `;

        const refused = await call(service, "/api/test/sensitive", {
          cookie: `bl_staff=${adminCookie}`,
        });
        expect(refused.status).toBe(401);
        expect(await refused.json()).toEqual({ code: "step_up_required" });

        const challengeResponse = await call(service, "/api/auth/challenge", {
          body: { maxAge: 0, returnTo: "/" },
          cookie: `bl_staff=${adminCookie}`,
          origin: STAFF_ORIGIN,
        });
        expect(challengeResponse.status).toBe(200);
        const challenge = (await challengeResponse.json()) as ChallengeView;
        expect(challenge.maxAge).toBe(0);
        const challengeCookie = cookieValue(challengeResponse, "bl_login");

        const stepUp = await call(service, "/api/auth/session", {
          body: {
            idToken: await signToken({
              sub: "admin",
              nonce: challenge.nonce,
              clientId: STAFF_CLIENT,
              authTime: Math.floor(Date.now() / 1_000),
            }),
          },
          cookie: `bl_staff=${adminCookie}; bl_login=${challengeCookie ?? ""}`,
          origin: STAFF_ORIGIN,
        });
        expect(stepUp.status).toBe(200);
        expect(cookieValue(stepUp, "bl_staff")).toBeUndefined();

        const [session] = (await database.sql`
          SELECT now() - last_auth_at < interval '1 minute' AS fresh
          FROM core.sessions s
          JOIN pii.identities i ON i.member_id = s.member_id
          WHERE i.sub = 'admin'
        `) as Array<{ fresh: boolean }>;
        expect(session?.fresh).toBe(true);

        const allowed = await call(service, "/api/test/sensitive", {
          cookie: `bl_staff=${adminCookie}`,
        });
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toEqual({ ok: true });
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("refuses a step-up with an old IdP auth_time", async () => {
    await withDb("auth_step_up_old", async (database) => {
      const { service, sql } = await staffServiceFor(database);

      try {
        const adminCookie = await login(service, "admin", "staff");
        await database.sql`
          UPDATE core.sessions SET last_auth_at = now() - interval '20 minutes'
          WHERE member_id = (SELECT member_id FROM pii.identities WHERE sub = 'admin')
        `;

        const challengeResponse = await call(service, "/api/auth/challenge", {
          body: { maxAge: 0, returnTo: "/" },
          cookie: `bl_staff=${adminCookie}`,
          origin: STAFF_ORIGIN,
        });
        expect(challengeResponse.status).toBe(200);
        const challenge = (await challengeResponse.json()) as ChallengeView;
        const challengeCookie = cookieValue(challengeResponse, "bl_login");

        const stepUp = await call(service, "/api/auth/session", {
          body: {
            idToken: await signToken({
              sub: "admin",
              nonce: challenge.nonce,
              clientId: STAFF_CLIENT,
              authTime: Math.floor(Date.now() / 1_000) - 2 * 60 * 60,
            }),
          },
          cookie: `bl_staff=${adminCookie}; bl_login=${challengeCookie ?? ""}`,
          origin: STAFF_ORIGIN,
        });
        expect(stepUp.status).toBe(401);
        expect(await stepUp.json()).toEqual({ code: "step_up_required" });

        const [session] = (await database.sql`
          SELECT now() - last_auth_at > interval '15 minutes' AS stale
          FROM core.sessions s
          JOIN pii.identities i ON i.member_id = s.member_id
          WHERE i.sub = 'admin'
        `) as Array<{ stale: boolean }>;
        expect(session?.stale).toBe(true);

        const refused = await call(service, "/api/test/sensitive", {
          cookie: `bl_staff=${adminCookie}`,
        });
        expect(refused.status).toBe(401);
        expect(await refused.json()).toEqual({ code: "step_up_required" });
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("rolls last_active_at into previous_visit_at after thirty minutes", async () => {
    await withDb("auth_activity", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const sessionCookie = await login(service, "activity-user");

        await database.sql`
          UPDATE core.members
          SET last_active_at = now() - interval '31 minutes',
              previous_visit_at = now() - interval '10 days'
          WHERE id = (SELECT member_id FROM pii.identities WHERE sub = 'activity-user')
        `;
        const [before] = (await database.sql`
          SELECT last_active_at FROM core.members
          WHERE id = (SELECT member_id FROM pii.identities WHERE sub = 'activity-user')
        `) as Array<{ last_active_at: Date }>;

        const active = await call(service, "/api/test/protected", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(active.status).toBe(200);

        const [after] = (await database.sql`
          SELECT previous_visit_at, last_active_at, last_active_at > previous_visit_at AS advanced
          FROM core.members
          WHERE id = (SELECT member_id FROM pii.identities WHERE sub = 'activity-user')
        `) as Array<{
          previous_visit_at: Date;
          last_active_at: Date;
          advanced: boolean;
        }>;
        expect(after?.previous_visit_at).toEqual(before?.last_active_at);
        expect(after?.advanced).toBe(true);

        await database.sql`
          UPDATE core.members
          SET last_active_at = now() - interval '5 minutes',
              previous_visit_at = '2020-01-01T00:00:00Z'
          WHERE id = (SELECT member_id FROM pii.identities WHERE sub = 'activity-user')
        `;
        await call(service, "/api/test/protected", {
          cookie: `bl_session=${sessionCookie}`,
        });

        const [recent] = (await database.sql`
          SELECT previous_visit_at
          FROM core.members
          WHERE id = (SELECT member_id FROM pii.identities WHERE sub = 'activity-user')
        `) as Array<{ previous_visit_at: Date }>;
        expect(recent?.previous_visit_at?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("requires Origin and CSRF for non-GET routes with only the named exemptions", async () => {
    await withDb("auth_csrf", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const sessionCookie = await login(service, "csrf-user");
        const csrfToken = await csrfFor(service, sessionCookie);
        const cookie = `bl_session=${sessionCookie}`;

        const missing = await call(service, "/api/test/protected", {
          method: "POST",
          cookie,
        });
        expect(missing.status).toBe(403);
        expect(await missing.json()).toEqual({ code: "invalid_csrf" });

        const wrong = await call(service, "/api/test/protected", {
          method: "POST",
          cookie,
          headers: { "x-bulletin-csrf": "wrong-token" },
        });
        expect(wrong.status).toBe(403);
        expect(await wrong.json()).toEqual({ code: "invalid_csrf" });

        const malformed = await call(service, "/api/test/protected", {
          method: "POST",
          cookie,
          headers: { "x-bulletin-csrf": "\u00e9".repeat(43) },
        });
        expect(malformed.status).toBe(403);
        expect(await malformed.json()).toEqual({ code: "invalid_csrf" });

        const allowed = await call(service, "/api/test/protected", {
          method: "POST",
          cookie,
          headers: { "x-bulletin-csrf": csrfToken },
        });
        expect(allowed.status).toBe(200);

        const wrongOrigin = await call(service, "/api/test/protected", {
          method: "POST",
          cookie,
          origin: "http://evil.test",
          headers: { "x-bulletin-csrf": csrfToken },
        });
        expect(wrongOrigin.status).toBe(403);
        expect(await wrongOrigin.json()).toEqual({ code: "invalid_origin" });

        const noSession = await call(service, "/api/test/protected", {
          method: "POST",
        });
        expect(noSession.status).toBe(401);
        expect(await noSession.json()).toEqual({ code: "unauthenticated" });

        const challenge = await call(service, "/api/auth/challenge", { body: {} });
        expect(challenge.status).toBe(200);

        const session = await call(service, "/api/auth/session", { body: {} });
        expect(session.status).toBe(400);
        expect(await session.json()).toEqual({ code: "invalid_request" });

        for (const path of ["/api/beacon", "/api/me/overlay", "/api/notifications/unsubscribe"]) {
          const raw = await service.handle(
            new Request(`http://api.test${path}`, {
              method: "POST",
              headers: { origin: USER_ORIGIN, cookie },
            }),
          );
          expect(raw).toBeNull();
        }

        const unknown = await service.handle(
          new Request("http://api.test/api/not-a-route", {
            method: "POST",
            headers: { origin: USER_ORIGIN, cookie },
          }),
        );
        expect(unknown?.status).toBe(403);
        expect(await unknown?.json()).toEqual({ code: "invalid_csrf" });

        const unknownWithToken = await service.handle(
          new Request("http://api.test/api/not-a-route", {
            method: "POST",
            headers: {
              origin: USER_ORIGIN,
              cookie,
              "x-bulletin-csrf": csrfToken,
            },
          }),
        );
        expect(unknownWithToken).toBeNull();
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("guards member APIs until a display name is chosen", async () => {
    await withDb("auth_display_guard", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const sessionCookie = await login(service, "name-user");
        const csrfToken = await csrfFor(service, sessionCookie);
        const cookie = `bl_session=${sessionCookie}`;

        const before = await call(service, "/api/me", { cookie });
        expect(before.status).toBe(409);
        expect(await before.json()).toEqual({ code: "display_name_required" });

        const localeBefore = await call(service, "/api/me/locale", {
          method: "POST",
          cookie,
          headers: { "x-bulletin-csrf": csrfToken },
          body: { locale: "fr" },
        });
        expect(localeBefore.status).toBe(409);
        expect(await localeBefore.json()).toEqual({ code: "display_name_required" });

        const invalid = await call(service, "/api/me/display-name", {
          method: "POST",
          cookie,
          headers: { "x-bulletin-csrf": csrfToken },
          body: { displayName: "ab" },
        });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ code: "display_name_invalid" });

        const set = await call(service, "/api/me/display-name", {
          method: "POST",
          cookie,
          headers: { "x-bulletin-csrf": csrfToken },
          body: { displayName: "Admin" },
        });
        expect(set.status).toBe(200);
        expect(await set.json()).toEqual({ displayName: "Admin" });

        const after = await call(service, "/api/me", { cookie });
        expect(after.status).toBe(200);
        expect(await after.json()).toMatchObject({ displayName: "Admin", locale: null });

        const session = await call(service, "/api/auth/session", { cookie });
        expect(await session.json()).toMatchObject({
          displayName: "Admin",
          displayNameRequired: false,
        });
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("rejects a confusable display name as already taken", async () => {
    await withDb("auth_display_confusable", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const firstCookie = await login(service, "first-name");
        const firstCsrf = await csrfFor(service, firstCookie);
        const firstSet = await call(service, "/api/me/display-name", {
          method: "POST",
          cookie: `bl_session=${firstCookie}`,
          headers: { "x-bulletin-csrf": firstCsrf },
          body: { displayName: "Admin" },
        });
        expect(firstSet.status).toBe(200);

        const secondCookie = await login(service, "second-name");
        const secondCsrf = await csrfFor(service, secondCookie);
        const confusable = await call(service, "/api/me/display-name", {
          method: "POST",
          cookie: `bl_session=${secondCookie}`,
          headers: { "x-bulletin-csrf": secondCsrf },
          body: { displayName: "Adm\u0456n" },
        });
        expect(confusable.status).toBe(409);
        expect(await confusable.json()).toEqual({ code: "display_name_taken" });

        const available = await call(service, "/api/me/display-name", {
          method: "POST",
          cookie: `bl_session=${secondCookie}`,
          headers: { "x-bulletin-csrf": secondCsrf },
          body: { displayName: "Alicia" },
        });
        expect(available.status).toBe(200);
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);

  test("records display-name changes and enforces the 30-day limit", async () => {
    await withDb("auth_display_changes", async (database) => {
      const user = await serviceFor(database);
      const staff = await staffServiceFor(database);

      try {
        const userCookie = await login(user.service, "rename-user");
        const userCsrf = await csrfFor(user.service, userCookie);
        const cookie = `bl_session=${userCookie}`;

        const first = await call(user.service, "/api/me/display-name", {
          method: "POST",
          cookie,
          headers: { "x-bulletin-csrf": userCsrf },
          body: { displayName: "First Name" },
        });
        expect(first.status).toBe(200);

        const changed = await call(user.service, "/api/me/display-name", {
          method: "POST",
          cookie,
          headers: { "x-bulletin-csrf": userCsrf },
          body: { displayName: "Second Name" },
        });
        expect(changed.status).toBe(200);

        const memberId = await memberIdFor(database, "rename-user");
        const history = (await database.sql`
          SELECT old_name, new_name, changed_by
          FROM core.member_name_history
          WHERE member_id = ${memberId}
          ORDER BY id
        `) as Array<{ old_name: string; new_name: string; changed_by: string }>;
        expect(history).toEqual([
          { old_name: "First Name", new_name: "Second Name", changed_by: memberId },
        ]);

        const limited = await call(user.service, "/api/me/display-name", {
          method: "POST",
          cookie,
          headers: { "x-bulletin-csrf": userCsrf },
          body: { displayName: "Third Name" },
        });
        expect(limited.status).toBe(429);
        const limitedBody = (await limited.json()) as {
          code: string;
          nextAllowedAt: string;
        };
        expect(limitedBody.code).toBe("display_name_change_limit");
        expect(Date.parse(limitedBody.nextAllowedAt)).toBeGreaterThan(
          Date.now() + 29 * 24 * 60 * 60 * 1_000,
        );

        const adminCookie = await login(staff.service, "admin", "staff");
        const regular = await directStaffSession(database, "regular-staff", "Regular Staff");

        const denied = await call(staff.service, `/api/staff/members/${memberId}/name-history`, {
          cookie: `bl_staff=${regular.cookie}`,
        });
        expect(denied.status).toBe(403);
        expect(await denied.json()).toEqual({ code: "forbidden" });

        const allowed = await call(staff.service, `/api/staff/members/${memberId}/name-history`, {
          cookie: `bl_staff=${adminCookie}`,
        });
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toMatchObject({
          history: [{ oldName: "First Name", newName: "Second Name", changedBy: memberId }],
        });
      } finally {
        await user.service.close();
        await user.sql.close();
        await staff.service.close();
        await staff.sql.close();
      }
    });
  }, 20_000);

  test("saves a member locale and resolves it across requests", async () => {
    await withDb("auth_display_locale", async (database) => {
      const { service, sql } = await serviceFor(database);

      try {
        const sessionCookie = await login(service, "locale-user");
        const csrfToken = await csrfFor(service, sessionCookie);
        const cookie = `bl_session=${sessionCookie}`;

        await call(service, "/api/me/display-name", {
          method: "POST",
          cookie,
          headers: { "x-bulletin-csrf": csrfToken },
          body: { displayName: "Locale User" },
        });

        const saved = await call(service, "/api/me/locale", {
          method: "POST",
          cookie,
          headers: { "x-bulletin-csrf": csrfToken },
          body: { locale: "fr" },
        });
        expect(saved.status).toBe(200);
        expect(await saved.json()).toEqual({ locale: "fr" });

        const memberId = await memberIdFor(database, "locale-user");
        expect(await resolveMemberLocale(database.sql, memberId)).toBe("fr");

        const me = await call(service, "/api/me", { cookie });
        expect(await me.json()).toMatchObject({ locale: "fr" });

        const defaultCookie = await login(service, "locale-default");
        const defaultCsrf = await csrfFor(service, defaultCookie);
        await call(service, "/api/me/display-name", {
          method: "POST",
          cookie: `bl_session=${defaultCookie}`,
          headers: { "x-bulletin-csrf": defaultCsrf },
          body: { displayName: "Default Locale" },
        });
        const defaultMember = await memberIdFor(database, "locale-default");

        await database.sql`
          INSERT INTO core.board_settings (id, board_name, default_locale)
          VALUES (1, 'Bulletin', 'fr')
          ON CONFLICT (id) DO UPDATE SET default_locale = 'fr'
        `;
        expect(await resolveMemberLocale(database.sql, defaultMember)).toBe("fr");
      } finally {
        await service.close();
        await sql.close();
      }
    });
  }, 20_000);
});
