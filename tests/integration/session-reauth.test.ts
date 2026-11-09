import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AuthService,
  type ChallengeView,
  createAuthService,
  type SessionView,
} from "@bulletin/domain/auth";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import { exportJWK, generateKeyPair, type KeyInput, SignJWT } from "jose";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const ISSUER = "http://auth.bulletin.localhost:8080";
const USER_ORIGIN = "http://bulletin.localhost:8080";
const USER_CLIENT = "bulletin-user";
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
    .setIssuer(ISSUER)
    .setAudience(USER_CLIENT)
    .setSubject(options.sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function login(service: AuthService, sub: string): Promise<string> {
  const challengeResponse = await call(service, "/api/auth/challenge", { body: {} });
  expect(challengeResponse.status).toBe(200);
  const challenge = (await challengeResponse.json()) as ChallengeView;
  const challengeCookie = cookieValue(challengeResponse, "bl_login");

  if (challengeCookie === undefined) {
    throw new Error("challenge cookie missing");
  }

  const response = await call(service, "/api/auth/session", {
    body: { idToken: await signToken({ sub, nonce: challenge.nonce }) },
    cookie: `bl_login=${challengeCookie}`,
  });
  expect(response.status).toBe(200);
  const sessionCookie = cookieValue(response, "bl_session");

  if (sessionCookie === undefined) {
    throw new Error("session cookie missing");
  }

  return sessionCookie;
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

  async function serviceFor(database: TestDatabase): Promise<{ service: AuthService; sql: SQL }> {
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

        await database.sql`
          UPDATE core.sessions SET reauth_at = now() - interval '3 hours'
          WHERE member_id = (SELECT member_id FROM pii.identities WHERE sub = 'grace-user')
        `;
        const after = await call(service, "/api/test/protected", {
          cookie: `bl_session=${sessionCookie}`,
        });
        expect(after.status).toBe(401);
        expect(await after.json()).toEqual({ code: "reauth_required" });
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

  test("rotates a marked session on the next response with a 60 s old-token overlap", async () => {
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

        await service.sessions.markMemberSessionsForRotation(row.member_id);

        const rotated = await call(service, "/api/test/protected", {
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
});
