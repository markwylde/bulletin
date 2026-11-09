import type { SQL } from "bun";
import { createJwks, verifyIdToken } from "./jwt.ts";
import {
  assignDefaultGroups,
  consumeChallenge,
  createChallenge,
  findChallenge,
  findSession,
  issueSession,
  resolveMember,
} from "./store.ts";
import {
  type AuthNodeEnv,
  CHALLENGE_MAX_AGE_SECONDS,
  challengeCookieName,
  clientIp,
  createCsrfToken,
  parseCookieHeader,
  SESSION_LIFETIMES,
  type SessionKind,
  safeReturnTo,
  serializeCookie,
  sessionCookieName,
  userAgent,
} from "./tokens.ts";

export interface AuthRouterOptions {
  readonly sql: SQL;
  readonly kind: SessionKind;
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly clientId: string;
  readonly origin: string;
  readonly sessionSecret: string;
  readonly nodeEnv: AuthNodeEnv;
  readonly bootstrapAdmins?: readonly AuthBootstrapAdmin[];
}

export interface AuthBootstrapAdmin {
  readonly issuer: string;
  readonly sub: string;
}

export interface ChallengeView {
  readonly state: string;
  readonly nonce: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly returnTo: string | null;
}

export interface SessionView {
  readonly authenticated: boolean;
  readonly csrfToken: string | null;
  readonly displayName: string | null;
  readonly displayNameRequired: boolean;
  readonly kind: SessionKind;
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

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
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

function sessionView(
  options: AuthRouterOptions,
  session: { readonly id: string; readonly displayName: string | null },
): SessionView {
  return {
    authenticated: true,
    csrfToken: createCsrfToken(session.id, options.sessionSecret),
    displayName: session.displayName,
    displayNameRequired: session.displayName === null,
    kind: options.kind,
  };
}

const GUEST_VIEW: SessionView = {
  authenticated: false,
  csrfToken: null,
  displayName: null,
  displayNameRequired: false,
  kind: "user",
};

function guestView(kind: SessionKind): SessionView {
  return { ...GUEST_VIEW, kind };
}

function originAllowed(request: Request, options: AuthRouterOptions): boolean {
  return request.headers.get("origin") === options.origin;
}

/**
 * The login endpoints shared by user-api and staff-api (ADR 0018). Returns `null` for
 * paths it does not own so each service can keep its own routing.
 */
export function createAuthRouter(
  options: AuthRouterOptions,
): (request: Request) => Promise<Response | null> {
  const jwks = createJwks(options.jwksUrl);
  const secure = options.nodeEnv === "production";
  const challengeCookie = challengeCookieName(options.nodeEnv);
  const sessionCookie = sessionCookieName(options.kind, options.nodeEnv);
  const sessionMaxAge = Math.trunc(SESSION_LIFETIMES[options.kind].absoluteMs / 1_000);

  async function challenge(request: Request): Promise<Response> {
    if (!originAllowed(request, options)) {
      return json({ code: "invalid_origin" }, 403);
    }

    const body = await readJson(request);

    if (body === null) {
      return json({ code: "invalid_request" }, 400);
    }

    const returnTo = typeof body.returnTo === "string" ? safeReturnTo(body.returnTo) : null;
    const created = await createChallenge(options.sql, options.kind, returnTo);
    const view: ChallengeView = {
      state: created.state,
      nonce: created.nonce,
      issuer: options.issuer,
      clientId: options.clientId,
      redirectUri: `${options.origin}/auth/callback`,
      returnTo,
    };

    return json(view, 200, [
      serializeCookie(challengeCookie, created.id, {
        maxAge: CHALLENGE_MAX_AGE_SECONDS,
        secure,
        httpOnly: true,
      }),
    ]);
  }

  async function createSession(request: Request): Promise<Response> {
    if (!originAllowed(request, options)) {
      return json({ code: "invalid_origin" }, 403);
    }

    const body = await readJson(request);

    if (body === null) {
      return json({ code: "invalid_request" }, 400);
    }

    const idToken = body.idToken;

    if (typeof idToken !== "string" || idToken === "" || idToken.length > 16_384) {
      return json({ code: "invalid_request" }, 400);
    }

    const challengeId = parseCookieHeader(request.headers.get("cookie"))[challengeCookie];

    if (challengeId === undefined) {
      return json({ code: "invalid_challenge" }, 401);
    }

    const stored = await findChallenge(options.sql, options.kind, challengeId);

    if (stored === null || stored.expired || stored.used) {
      return json({ code: "invalid_challenge" }, 401);
    }

    const identity = await verifyIdToken(
      jwks,
      { issuer: options.issuer, clientId: options.clientId, nonce: stored.nonce },
      idToken,
    ).catch(() => null);

    if (identity === null) {
      return json({ code: "invalid_token" }, 401);
    }

    const result = await options.sql.begin(async (tx) => {
      if (!(await consumeChallenge(tx, options.kind, challengeId))) {
        return null;
      }

      const member = await resolveMember(tx, identity);
      await assignDefaultGroups(
        tx,
        member.id,
        (options.bootstrapAdmins ?? []).some(
          (admin) => admin.issuer === identity.issuer && admin.sub === identity.sub,
        ),
      );
      const session = await issueSession(tx, {
        kind: options.kind,
        memberId: member.id,
        ip: clientIp(request),
        userAgent: userAgent(request),
      });

      return { session, member };
    });

    if (result === null) {
      return json({ code: "invalid_challenge" }, 401);
    }

    return json(
      sessionView(options, {
        id: result.session.id,
        displayName: result.member.displayName,
      }),
      200,
      [
        serializeCookie(sessionCookie, result.session.token, {
          maxAge: sessionMaxAge,
          secure,
          httpOnly: true,
        }),
        serializeCookie(challengeCookie, "", { maxAge: 0, secure, httpOnly: true }),
      ],
    );
  }

  async function readSession(request: Request): Promise<Response> {
    const token = parseCookieHeader(request.headers.get("cookie"))[sessionCookie];

    if (token === undefined || token === "") {
      return json(guestView(options.kind));
    }

    const session = await findSession(options.sql, options.kind, token);

    return json(session === null ? guestView(options.kind) : sessionView(options, session));
  }

  return async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/auth/challenge") {
      if (request.method !== "POST") {
        return json({ code: "method_not_allowed" }, 405);
      }

      return challenge(request);
    }

    if (pathname === "/api/auth/session") {
      if (request.method === "POST") {
        return createSession(request);
      }

      if (request.method === "GET") {
        return readSession(request);
      }

      return json({ code: "method_not_allowed" }, 405);
    }

    return null;
  };
}
