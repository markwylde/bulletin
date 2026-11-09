import { isLocale, type Locale } from "@bulletin/i18n";
import type { SQL } from "bun";
import { validateDisplayName } from "../member/names.ts";
import {
  readMember,
  readNameHistory,
  resolveMemberLocale,
  saveMemberLocale,
  updateDisplayName,
} from "../member/store.ts";
import {
  acpPermissionsFor,
  DEFAULT_STAFF_SCHEME,
  isStaffScheme,
  type StaffScheme,
} from "../permissions/acp.ts";
import { can } from "../permissions/can.ts";
import type { AuthRouterOptions, SessionCapabilities } from "./router.ts";
import { createAuthRouter, guestView, sessionView } from "./router.ts";
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
  /** Staff-only audit hook, called in the same transaction as a locale preference write. */
  readonly onStaffLocaleChange?: (sql: SQL, change: StaffLocaleChange) => Promise<void>;
}

export interface StaffLocaleChange {
  readonly memberId: string;
  readonly before: string | null;
  readonly after: Locale;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();

  if (text.trim() === "") {
    return {};
  }

  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
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

interface StaffSessionContext extends SessionCapabilities {
  readonly scheme: StaffScheme;
}

/** ACP capabilities and the remembered colour mode for the staff session view. */
async function readStaffSessionContext(sql: SQL, memberId: string): Promise<StaffSessionContext> {
  const [preferences] = (await sql`
    SELECT staff_scheme
    FROM core.member_prefs
    WHERE member_id = ${memberId}
  `) as Array<{ staff_scheme: string }>;
  const scheme = isStaffScheme(preferences?.staff_scheme)
    ? preferences.staff_scheme
    : DEFAULT_STAFF_SCHEME;

  return { permissions: await acpPermissionsFor(sql, memberId), scheme };
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

  async function withSession(
    request: Request,
    next: AuthNext,
    hooks: { readonly onReauthRequired?: (session: SessionRecord) => Response } = {},
  ): Promise<Response> {
    const token = parseCookieHeader(request.headers.get("cookie"))[cookieName];
    const session = token === undefined ? null : await sessions.find(options.kind, token);

    if (session === null) {
      return next({ session: null, csrfToken: null });
    }

    if (options.kind === "staff" && !(await can(options.sql, session.memberId, "acp.access"))) {
      return json({ code: "forbidden" }, 403);
    }

    if (options.kind === "user" && Date.now() > session.reauthAt.getTime() + REAUTH_GRACE_MS) {
      return hooks.onReauthRequired?.(session) ?? json({ code: "reauth_required" }, 401);
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

  async function memberMe(request: Request): Promise<Response> {
    return withSession(request, async ({ session }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      const member = await readMember(options.sql, session.memberId);

      if (member === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      if (member.displayName === null) {
        return json({ code: "display_name_required" }, 409);
      }

      return json({
        memberId: session.memberId,
        displayName: member.displayName,
        locale: member.locale,
      });
    });
  }

  async function setDisplayName(request: Request): Promise<Response> {
    return withSession(request, async ({ session }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      const body = await readJsonBody(request);

      if (body === null) {
        return json({ code: "invalid_request" }, 400);
      }

      const name = validateDisplayName(body.displayName);

      if (!name.ok) {
        return json({ code: name.code }, 400);
      }

      const result = await updateDisplayName(options.sql, session.memberId, name);

      if (result.kind === "missing") {
        return json({ code: "unauthenticated" }, 401);
      }

      if (result.kind === "taken") {
        return json({ code: "display_name_taken" }, 409);
      }

      if (result.kind === "limit") {
        return json(
          {
            code: "display_name_change_limit",
            nextAllowedAt: result.nextAllowedAt.toISOString(),
          },
          429,
        );
      }

      sessions.invalidate?.();
      return json({ displayName: result.displayName });
    });
  }

  async function saveLocale(request: Request): Promise<Response> {
    return withSession(request, async ({ session }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      const member = await readMember(options.sql, session.memberId);

      if (member === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      if (member.displayName === null) {
        return json({ code: "display_name_required" }, 409);
      }

      const body = await readJsonBody(request);

      if (body === null) {
        return json({ code: "invalid_request" }, 400);
      }

      if (typeof body.locale !== "string" || !isLocale(body.locale)) {
        return json({ code: "invalid_locale" }, 400);
      }

      const nextLocale: Locale = body.locale;
      const hook = options.kind === "staff" ? options.onStaffLocaleChange : undefined;

      if (hook === undefined) {
        await saveMemberLocale(options.sql, session.memberId, nextLocale);
      } else {
        await options.sql.begin(async (tx) => {
          await saveMemberLocale(tx, session.memberId, nextLocale);
          await hook(tx, {
            memberId: session.memberId,
            before: member.locale,
            after: nextLocale,
          });
        });
      }

      return json({ locale: nextLocale });
    });
  }

  async function nameHistory(request: Request, memberId: string): Promise<Response> {
    return withSession(request, async ({ session }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      if (!(await can(options.sql, session.memberId, "members.view_name_history"))) {
        return json({ code: "forbidden" }, 403);
      }

      const history = await readNameHistory(options.sql, memberId);

      return json({
        history: history.map((entry) => ({
          oldName: entry.oldName,
          newName: entry.newName,
          changedAt: entry.changedAt.toISOString(),
          changedBy: entry.changedBy,
        })),
      });
    });
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

      if (pathname === "/api/auth/session" && request.method === "GET") {
        return withSession(
          request,
          async ({ session }) => {
            if (session === null) {
              return json(guestView(options.kind));
            }

            const locale = await resolveMemberLocale(options.sql, session.memberId);
            const capabilities =
              options.kind === "staff"
                ? await readStaffSessionContext(options.sql, session.memberId)
                : {};
            return json(sessionView(options, session, locale, capabilities));
          },
          {
            onReauthRequired: (session) =>
              json(
                {
                  code: "reauth_required",
                  csrfToken: createCsrfToken(session.id, options.sessionSecret),
                  memberId: session.memberId,
                  kind: options.kind,
                },
                401,
              ),
          },
        );
      }

      const authResponse = await router(request);

      if (authResponse !== null) {
        return authResponse;
      }

      if (pathname === "/api/me") {
        if (request.method !== "GET") {
          return json({ code: "method_not_allowed" }, 405);
        }

        return memberMe(request);
      }

      if (pathname === "/api/me/display-name") {
        if (request.method !== "POST") {
          return json({ code: "method_not_allowed" }, 405);
        }

        return setDisplayName(request);
      }

      if (pathname === "/api/me/locale") {
        if (request.method !== "POST") {
          return json({ code: "method_not_allowed" }, 405);
        }

        return saveLocale(request);
      }

      if (options.kind === "staff") {
        const historyMatch = /^\/api\/staff\/members\/(\d+)\/name-history$/.exec(pathname);

        if (historyMatch !== null) {
          if (request.method !== "GET") {
            return json({ code: "method_not_allowed" }, 405);
          }

          return nameHistory(request, historyMatch[1] ?? "");
        }
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
