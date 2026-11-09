import type { Locale } from "@bulletin/i18n";
import type { SQL } from "bun";
import { can } from "../permissions/can.ts";
import { createJwks, type IdTokenClaims, IdTokenError, verifyIdToken } from "./jwt.ts";
import { exchangeAuthorizationCode, OidcError } from "./oidc.ts";
import { directSessionLookup, type SessionLookup, type SessionRecord } from "./session-store.ts";
import {
  assignDefaultGroups,
  consumeChallenge,
  createChallenge,
  findChallenge,
  issueSession,
  resolveMember,
} from "./store.ts";
import {
  AUTH_TIME_SKEW_MS,
  type AuthNodeEnv,
  CHALLENGE_MAX_AGE_SECONDS,
  challengeCookieName,
  clientIp,
  codeChallengeS256,
  createCsrfToken,
  createToken,
  parseCookieHeader,
  REAUTH_GRACE_MS,
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
  readonly sessions?: SessionLookup;
  readonly tokenUrl?: string;
  readonly oidcFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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
  readonly maxAge: number | null;
}

export interface SessionView {
  readonly authenticated: boolean;
  readonly csrfToken: string | null;
  readonly memberId: string | null;
  readonly displayName: string | null;
  readonly displayNameRequired: boolean;
  readonly locale: Locale | null;
  readonly reauthAt: string | null;
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

export function sessionView(
  options: AuthRouterOptions,
  session: SessionRecord,
  locale: Locale | null = null,
): SessionView {
  return {
    authenticated: true,
    csrfToken: createCsrfToken(session.id, options.sessionSecret),
    memberId: session.memberId,
    displayName: session.displayName,
    displayNameRequired: session.displayName === null,
    locale,
    reauthAt: session.reauthAt.toISOString(),
    kind: options.kind,
  };
}

const GUEST_VIEW: SessionView = {
  authenticated: false,
  csrfToken: null,
  memberId: null,
  displayName: null,
  displayNameRequired: false,
  locale: null,
  reauthAt: null,
  kind: "user",
};

export function guestView(kind: SessionKind): SessionView {
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
  const sessions = options.sessions ?? directSessionLookup(options.sql);

  async function challenge(request: Request): Promise<Response> {
    if (!originAllowed(request, options)) {
      return json({ code: "invalid_origin" }, 403);
    }

    const body = await readJson(request);

    if (body === null) {
      return json({ code: "invalid_request" }, 400);
    }

    const returnTo = typeof body.returnTo === "string" ? safeReturnTo(body.returnTo) : null;
    const maxAgeValue = body.maxAge;
    let maxAge: number | null = null;

    if (maxAgeValue !== undefined) {
      if (maxAgeValue !== 0 || options.kind !== "staff") {
        return json({ code: "invalid_request" }, 400);
      }

      maxAge = 0;
    }

    if (maxAge !== null) {
      const token = parseCookieHeader(request.headers.get("cookie"))[sessionCookie];
      const session = token === undefined ? null : await sessions.find(options.kind, token);

      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      const created = await createChallenge(options.sql, options.kind, {
        returnTo,
        sessionId: session.id,
        maxAge,
      });

      return json(
        {
          state: created.state,
          nonce: created.nonce,
          issuer: options.issuer,
          clientId: options.clientId,
          redirectUri: `${options.origin}/auth/callback`,
          returnTo,
          maxAge,
        } satisfies ChallengeView,
        200,
        [
          serializeCookie(challengeCookie, created.id, {
            maxAge: CHALLENGE_MAX_AGE_SECONDS,
            secure,
            httpOnly: true,
          }),
        ],
      );
    }

    const created = await createChallenge(options.sql, options.kind, { returnTo });
    const view: ChallengeView = {
      state: created.state,
      nonce: created.nonce,
      issuer: options.issuer,
      clientId: options.clientId,
      redirectUri: `${options.origin}/auth/callback`,
      returnTo,
      maxAge: null,
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

    if (stored.maxAge === null && stored.codeVerifier !== null) {
      return json({ code: "invalid_challenge" }, 401);
    }

    if (stored.maxAge !== null) {
      const sessionToken = parseCookieHeader(request.headers.get("cookie"))[sessionCookie];
      const session =
        sessionToken === undefined ? null : await sessions.find(options.kind, sessionToken);
      const authTime = identity.authTime?.getTime();

      if (
        session === null ||
        stored.sessionId === null ||
        session.id !== stored.sessionId ||
        authTime === undefined ||
        Math.abs(authTime - stored.createdAt.getTime()) > AUTH_TIME_SKEW_MS
      ) {
        return json({ code: "step_up_required" }, 401);
      }

      const consumed = await options.sql
        .begin(async (tx) => {
          if (!(await consumeChallenge(tx, options.kind, challengeId))) {
            return false;
          }

          const member = await resolveMember(tx, identity);

          if (member.id !== session.memberId) {
            throw new Error("step_up_member_mismatch");
          }

          await tx`
            UPDATE core.sessions SET last_auth_at = ${new Date(authTime)}
            WHERE id = ${session.id}
          `;
          return true;
        })
        .catch(() => false);

      if (!consumed) {
        return json({ code: "invalid_challenge" }, 401);
      }

      sessions.invalidate?.();
      const updated = await sessions.find(options.kind, sessionToken ?? "");

      if (updated === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      return json(sessionView(options, updated), 200, [
        serializeCookie(challengeCookie, "", { maxAge: 0, secure, httpOnly: true }),
      ]);
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

      if (options.kind === "staff" && !(await can(tx, member.id, "acp.access"))) {
        return { forbidden: true };
      }

      const session = await issueSession(tx, {
        kind: options.kind,
        memberId: member.id,
        ip: clientIp(request),
        userAgent: userAgent(request),
        authTime: identity.authTime,
      });

      return { session, member };
    });

    if (result === null) {
      return json({ code: "invalid_challenge" }, 401);
    }

    if ("forbidden" in result) {
      return json({ code: "forbidden" }, 403);
    }

    const record: SessionRecord = {
      id: result.session.id,
      memberId: result.member.id,
      kind: options.kind,
      displayName: result.member.displayName,
      createdAt: new Date(result.session.createdAt),
      lastSeenAt: new Date(result.session.lastSeenAt),
      reauthAt: new Date(result.session.reauthAt),
      lastAuthAt: new Date(result.session.lastAuthAt),
      reauthRetryCount: 0,
      revokedAt: null,
      rotatePending: false,
      viaPreviousToken: false,
      previousTokenExpiresAt: null,
    };

    return json(sessionView(options, record), 200, [
      serializeCookie(sessionCookie, result.session.token, {
        maxAge: sessionMaxAge,
        secure,
        httpOnly: true,
      }),
      serializeCookie(challengeCookie, "", { maxAge: 0, secure, httpOnly: true }),
    ]);
  }

  async function readSession(request: Request): Promise<Response> {
    const token = parseCookieHeader(request.headers.get("cookie"))[sessionCookie];

    if (token === undefined || token === "") {
      return json(guestView(options.kind));
    }

    const session = await sessions.find(options.kind, token);

    if (session === null) {
      return json(guestView(options.kind));
    }

    if (options.kind === "staff" && !(await can(options.sql, session.memberId, "acp.access"))) {
      return json({ code: "forbidden" }, 403);
    }

    if (options.kind === "user" && Date.now() > session.reauthAt.getTime() + REAUTH_GRACE_MS) {
      return json({ code: "reauth_required" }, 401);
    }

    await sessions.touch?.(session);

    const rotated =
      session.rotatePending && sessions.rotate !== undefined
        ? await sessions.rotate(session)
        : null;

    return json(
      sessionView(options, session),
      200,
      rotated === null
        ? []
        : [
            serializeCookie(sessionCookie, rotated.token, {
              maxAge: sessionMaxAge,
              secure,
              httpOnly: true,
            }),
          ],
    );
  }

  const tokenUrl = options.tokenUrl ?? `${options.issuer}/token`;
  const callbackUrl = `${options.origin}/api/auth/callback`;

  function isOutageError(error: unknown): boolean {
    return (
      (error instanceof OidcError || error instanceof IdTokenError) && error.kind === "network"
    );
  }

  function redirect(location: string, cookies: readonly string[] = []): Response {
    const headers = new Headers({ location, "cache-control": "no-store" });

    for (const cookie of cookies) {
      headers.append("set-cookie", cookie);
    }

    return new Response(null, { status: 303, headers });
  }

  function withAuthError(returnTo: string): string {
    const url = new URL(returnTo, "https://bulletin.invalid");
    url.searchParams.set("auth_error", "1");
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function clearSessionCookies(): string[] {
    return [
      serializeCookie(sessionCookie, "", { maxAge: 0, secure, httpOnly: true }),
      serializeCookie(challengeCookie, "", { maxAge: 0, secure, httpOnly: true }),
    ];
  }

  async function revokeSession(sessionId: string): Promise<void> {
    if (sessions.revoke !== undefined) {
      await sessions.revoke(sessionId);
      return;
    }

    await options.sql`
      UPDATE core.sessions SET revoked_at = now()
      WHERE id = ${sessionId} AND revoked_at IS NULL
    `;
    await options.sql`SELECT pg_notify('session_revoked', ${sessionId})`;
  }

  async function logout(request: Request): Promise<Response> {
    if (!originAllowed(request, options)) {
      return json({ code: "invalid_origin" }, 403);
    }

    const token = parseCookieHeader(request.headers.get("cookie"))[sessionCookie];

    if (token !== undefined) {
      const session = await sessions.find(options.kind, token);

      if (session !== null) {
        await revokeSession(session.id);
      }
    }

    return json({ code: "logged_out", clearLocalData: true }, 200, [
      serializeCookie(sessionCookie, "", { maxAge: 0, secure, httpOnly: true }),
    ]);
  }

  /** Starts the silent top-level re-auth through DarkAuth with `prompt=none` (ADR 0018). */
  async function refresh(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const returnTo = safeReturnTo(url.searchParams.get("return_to")) ?? "/";
    const token = parseCookieHeader(request.headers.get("cookie"))[sessionCookie];
    const session = token === undefined ? null : await sessions.find("user", token);

    if (session === null) {
      return redirect(withAuthError(returnTo), clearSessionCookies());
    }

    const verifier = createToken();
    const created = await createChallenge(options.sql, "user", {
      returnTo,
      sessionId: session.id,
      codeVerifier: verifier,
    });
    const authorizeUrl = new URL(`${options.issuer}/authorize`);
    authorizeUrl.searchParams.set("client_id", options.clientId);
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "openid profile email");
    authorizeUrl.searchParams.set("state", created.state);
    authorizeUrl.searchParams.set("nonce", created.nonce);
    authorizeUrl.searchParams.set("code_challenge", codeChallengeS256(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("prompt", "none");

    return redirect(authorizeUrl.toString(), [
      serializeCookie(challengeCookie, created.id, {
        maxAge: CHALLENGE_MAX_AGE_SECONDS,
        secure,
        httpOnly: true,
      }),
    ]);
  }

  /** Completes the server-side code exchange and extends `reauth_at`. */
  async function callback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const challengeId = parseCookieHeader(request.headers.get("cookie"))[challengeCookie];

    if (challengeId === undefined) {
      return redirect(withAuthError("/"), clearSessionCookies());
    }

    const stored = await findChallenge(options.sql, "user", challengeId);

    if (
      stored === null ||
      stored.expired ||
      stored.used ||
      stored.sessionId === null ||
      stored.codeVerifier === null
    ) {
      return redirect(withAuthError(stored?.returnTo ?? "/"), [
        serializeCookie(challengeCookie, "", { maxAge: 0, secure, httpOnly: true }),
      ]);
    }

    const returnTo = safeReturnTo(stored.returnTo) ?? "/";
    const state = url.searchParams.get("state");

    if (state === null || state !== stored.state) {
      return redirect(withAuthError(returnTo), [
        serializeCookie(challengeCookie, "", { maxAge: 0, secure, httpOnly: true }),
      ]);
    }

    if (url.searchParams.has("error")) {
      await revokeSession(stored.sessionId);
      return redirect(withAuthError(returnTo), clearSessionCookies());
    }

    const code = url.searchParams.get("code");

    if (code === null) {
      await revokeSession(stored.sessionId);
      return redirect(withAuthError(returnTo), clearSessionCookies());
    }

    let identity: IdTokenClaims;
    let outage = false;

    try {
      const exchanged = await exchangeAuthorizationCode({
        tokenUrl,
        clientId: options.clientId,
        code,
        redirectUri: callbackUrl,
        codeVerifier: stored.codeVerifier,
        ...(options.oidcFetch === undefined ? {} : { fetch: options.oidcFetch }),
      });
      identity = await verifyIdToken(
        jwks,
        { issuer: options.issuer, clientId: options.clientId, nonce: stored.nonce },
        exchanged.idToken,
      );
    } catch (error) {
      outage = isOutageError(error);

      if (!outage) {
        await revokeSession(stored.sessionId);
        return redirect(withAuthError(returnTo), clearSessionCookies());
      }
    }

    if (outage) {
      const extended = await options.sql.begin(async (tx) => {
        if (!(await consumeChallenge(tx, "user", challengeId))) {
          return false;
        }

        const rows = (await tx`
          UPDATE core.sessions
          SET reauth_at = now() + interval '1 hour',
              reauth_retry_count = reauth_retry_count + 1
          WHERE id = ${stored.sessionId}
            AND reauth_retry_count < 3
          RETURNING id
        `) as Array<{ id: string }>;

        return rows.length === 1;
      });

      if (extended) {
        sessions.invalidate?.();
        return redirect(returnTo, [
          serializeCookie(challengeCookie, "", { maxAge: 0, secure, httpOnly: true }),
        ]);
      }

      await revokeSession(stored.sessionId);
      return redirect(withAuthError(returnTo), clearSessionCookies());
    }

    const result = await options.sql.begin(async (tx) => {
      if (!(await consumeChallenge(tx, "user", challengeId))) {
        return null;
      }

      const [row] = (await tx`
        SELECT member_id FROM core.sessions
        WHERE id = ${stored.sessionId} AND kind = 'user' AND revoked_at IS NULL
      `) as Array<{ member_id: string }>;

      if (row === undefined) {
        return null;
      }

      const member = await resolveMember(tx, identity);

      if (member.id !== row.member_id) {
        return null;
      }

      await tx`
        UPDATE core.sessions
        SET reauth_at = now() + make_interval(hours => ${SESSION_LIFETIMES.user.reauthHours}),
            reauth_retry_count = 0
        WHERE id = ${stored.sessionId}
      `;

      return { memberId: member.id };
    });

    if (result === null) {
      await revokeSession(stored.sessionId);
      return redirect(withAuthError(returnTo), clearSessionCookies());
    }

    sessions.invalidate?.();
    return redirect(returnTo, [
      serializeCookie(challengeCookie, "", { maxAge: 0, secure, httpOnly: true }),
    ]);
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

    if (pathname === "/api/auth/logout") {
      if (request.method !== "POST") {
        return json({ code: "method_not_allowed" }, 405);
      }

      return logout(request);
    }

    if (options.kind === "user" && pathname === "/api/auth/refresh") {
      if (request.method !== "GET") {
        return json({ code: "method_not_allowed" }, 405);
      }

      return refresh(request);
    }

    if (options.kind === "user" && pathname === "/api/auth/callback") {
      if (request.method !== "GET") {
        return json({ code: "method_not_allowed" }, 405);
      }

      return callback(request);
    }

    return null;
  };
}
