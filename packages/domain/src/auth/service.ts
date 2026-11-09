import { can } from "../permissions/can.ts";
import type { AuthRouterOptions } from "./router.ts";
import { createAuthRouter } from "./router.ts";
import { createSessionStore, type SessionRecord, type SessionStore } from "./session-store.ts";
import {
  createCsrfToken,
  parseCookieHeader,
  REAUTH_GRACE_MS,
  SESSION_LIFETIMES,
  STEP_UP_WINDOW_MS,
  serializeCookie,
  sessionCookieName,
  verifyCsrfToken,
} from "./tokens.ts";

/** The ADR 0018 exemptions, by exact method and path. Nothing else bypasses CSRF. */
const CSRF_EXEMPT = new Set([
  "POST /api/auth/challenge",
  "POST /api/auth/session",
  "POST /api/beacon",
  "POST /api/me/overlay",
  "POST /api/notifications/unsubscribe",
]);

export function isCsrfExempt(method: string, pathname: string): boolean {
  return CSRF_EXEMPT.has(`${method.toUpperCase()} ${pathname}`);
}

export interface AuthServiceOptions extends AuthRouterOptions {
  readonly cacheTtlMs?: number;
  readonly testEndpoints?: boolean;
}

export interface AuthRequestContext {
  readonly session: SessionRecord | null;
  readonly csrfToken: string | null;
}

export type AuthNext = (context: AuthRequestContext) => Promise<Response>;

export interface AuthService {
  /** Handles auth endpoints and (in development) the test-only session endpoints. */
  handle(request: Request, next?: AuthNext): Promise<Response | null>;
  close(): Promise<void>;
  readonly sessions: SessionStore;
}

function json(body: unknown, status = 200, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function withSetCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The complete auth service for one origin: login, session lookup/middleware, rotation,
 * silent re-auth and the test-only endpoints. `handle` returns `null` for paths the service
 * does not own so an app can keep its own routes.
 */
export async function createAuthService(options: AuthServiceOptions): Promise<AuthService> {
  const sessions = await createSessionStore({
    sql: options.sql,
    ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
  });
  const router = createAuthRouter({ ...options, sessions });
  const secure = options.nodeEnv === "production";
  const cookieName = sessionCookieName(options.kind, options.nodeEnv);
  const sessionMaxAge = Math.trunc(SESSION_LIFETIMES[options.kind].absoluteMs / 1_000);

  async function withSession(request: Request, next: AuthNext): Promise<Response> {
    const token = parseCookieHeader(request.headers.get("cookie"))[cookieName];
    const session = token === undefined ? null : await sessions.find(options.kind, token);

    if (session === null) {
      return next({ session: null, csrfToken: null });
    }

    if (options.kind === "user" && Date.now() > session.reauthAt.getTime() + REAUTH_GRACE_MS) {
      return json({ code: "reauth_required" }, 401);
    }

    await sessions.touch(session);
    const response = await next({
      session,
      csrfToken: createCsrfToken(session.id, options.sessionSecret),
    });

    if (!session.rotatePending) {
      return response;
    }

    const rotated = await sessions.rotate(session);

    if (rotated === null) {
      return response;
    }

    return withSetCookie(
      response,
      serializeCookie(cookieName, rotated.token, {
        maxAge: sessionMaxAge,
        secure,
        httpOnly: true,
      }),
    );
  }

  function testEndpoint(request: Request, pathname: string): Promise<Response> | null {
    if (options.testEndpoints !== true) {
      return null;
    }

    if (pathname === "/api/test/protected") {
      if (request.method !== "GET" && request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      return withSession(request, async ({ session }) => {
        if (session === null) {
          return json({ code: "unauthenticated" }, 401);
        }

        return json({ ok: true, memberId: session.memberId, kind: session.kind });
      });
    }

    if (pathname === "/api/test/age-session") {
      if (request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      return withSession(request, async ({ session }) => {
        if (session === null) {
          return json({ code: "unauthenticated" }, 401);
        }

        await options.sql`
          UPDATE core.sessions
          SET last_auth_at = now() - interval '20 minutes'
          WHERE id = ${session.id}
        `;
        sessions.invalidate();

        return json({ ok: true });
      });
    }

    if (pathname === "/api/test/age-reauth") {
      if (options.kind !== "user") {
        return null;
      }

      if (request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      return withSession(request, async ({ session }) => {
        if (session === null) {
          return json({ code: "unauthenticated" }, 401);
        }

        await options.sql`
          UPDATE core.sessions
          SET reauth_at = now() - interval '25 hours'
          WHERE id = ${session.id}
        `;
        sessions.invalidate();
        await options.sql`SELECT pg_notify('session_revoked', ${session.id})`;

        return json({ ok: true });
      });
    }

    if (options.kind === "staff" && pathname === "/api/test/sensitive") {
      if (request.method !== "GET" && request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      return withSession(request, async ({ session }) => {
        if (session === null) {
          return json({ code: "unauthenticated" }, 401);
        }

        if (Date.now() - session.lastAuthAt.getTime() > STEP_UP_WINDOW_MS) {
          return json({ code: "step_up_required" }, 401);
        }

        return json({ ok: true });
      });
    }

    return null;
  }

  async function handleStaffRevoke(request: Request, memberId: string): Promise<Response> {
    if (request.method !== "POST") {
      return json({ code: "method_not_allowed" }, 405);
    }

    return withSession(request, async ({ session }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      if (!(await can(options.sql, session.memberId, "sessions.revoke"))) {
        return json({ code: "forbidden" }, 403);
      }

      const revoked = await sessions.revokeMemberSessions(memberId);
      return json({ revoked });
    });
  }

  return {
    sessions,
    async handle(request, next) {
      const { pathname } = new URL(request.url);

      if (request.method !== "GET" && request.method !== "HEAD") {
        if (request.headers.get("origin") !== options.origin) {
          return json({ code: "invalid_origin" }, 403);
        }

        if (!isCsrfExempt(request.method, pathname)) {
          const token = parseCookieHeader(request.headers.get("cookie"))[cookieName];
          const session = token === undefined ? null : await sessions.find(options.kind, token);

          if (session === null) {
            return json({ code: "unauthenticated" }, 401);
          }

          if (
            !verifyCsrfToken(
              request.headers.get("x-bulletin-csrf"),
              createCsrfToken(session.id, options.sessionSecret),
            )
          ) {
            return json({ code: "invalid_csrf" }, 403);
          }
        }
      }

      const authResponse = await router(request);

      if (authResponse !== null) {
        return authResponse;
      }

      if (options.kind === "staff") {
        const match = /^\/api\/staff\/members\/(\d+)\/sessions\/revoke$/.exec(pathname);

        if (match !== null) {
          return handleStaffRevoke(request, match[1] ?? "");
        }
      }

      const testResponse = testEndpoint(request, pathname);

      if (testResponse !== null) {
        return testResponse;
      }

      return next === undefined ? null : withSession(request, next);
    },
    async close() {
      await sessions.close();
    },
  };
}
