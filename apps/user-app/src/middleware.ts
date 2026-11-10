import { defineMiddleware } from "astro:middleware";
import { createDrainController } from "@bulletin/config/drain";
import { applySecurityHeaders, createCspNonce } from "@bulletin/config/security";
import { parseCookieHeader } from "@bulletin/domain/auth";
import { reauthRedirectUrl, shouldRedirectToReauth } from "@bulletin/domain/auth/silent";
import { BP_COOKIE_NAME, resolveRequestLocale } from "@bulletin/i18n";
import { canViewOffline, readBoard } from "./board.ts";
import { readSql } from "./db.ts";
import { offlinePage } from "./offline.ts";
import { closeSessionReadPool, currentSessionContext } from "./session.ts";

const userApiUrl = process.env.USER_API_INTERNAL_URL ?? "http://user-api:3001";
const authIssuer =
  process.env.BULLETIN_AUTH_ISSUER ??
  `http://auth.bulletin.localhost:${process.env.BULLETIN_HTTP_PORT ?? "8080"}`;
const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development";
const drain = import.meta.env.DEV ? createDrainController() : null;

// Astro's own asset endpoints are not pages. `/_demo/*` is a page and must go through the
// session, locale and board logic below, so the bare "/_" prefix is deliberately absent.
const NON_PAGE_PREFIXES = [
  "/api/",
  "/health/",
  "/auth/",
  "/_astro/",
  "/_image",
  "/@",
  "/src/",
  "/favicon.ico",
];
const DISPLAY_NAME_PATH = "/display-name";

if (import.meta.env.DEV) {
  process.once("SIGTERM", () => {
    void drain?.drain(Number(process.env.BULLETIN_DRAIN_TIMEOUT_MS ?? 25_000)).finally(() => {
      void closeSessionReadPool();
      process.exit(0);
    });
  });
}

async function readiness(): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetch(`${userApiUrl}/health/ready`);
    const body: unknown = await response.json().catch(() => ({
      status: response.ok ? "ok" : "unavailable",
    }));

    return { status: response.ok ? 200 : 503, body };
  } catch {
    return { status: 503, body: { status: "unavailable", checks: { userApi: false } } };
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const finish = drain?.track();
  const nonce = createCspNonce();
  context.locals.cspNonce = nonce;
  const secure = (response: Response): Response =>
    applySecurityHeaders(response, {
      nonce,
      nodeEnv,
      connectSrc: [authIssuer],
    });

  try {
    if (context.url.pathname === "/health/live") {
      return secure(Response.json({ status: "ok", service: "user-app" }));
    }

    if (context.url.pathname === "/health/ready") {
      if (drain?.draining === true) {
        return secure(Response.json({ status: "draining", checks: {} }, { status: 503 }));
      }

      const result = await readiness();
      return secure(Response.json(result.body, { status: result.status }));
    }

    const isNavigation =
      context.request.method === "GET" &&
      context.request.headers.get("sec-fetch-mode") === "navigate";
    const isPageRequest = !NON_PAGE_PREFIXES.some((prefix) =>
      context.url.pathname.startsWith(prefix),
    );

    // Prerendered pages cannot read request cookies. Spike S1 moved the user app to SSR
    // output (ADR 0008), so every page request takes the enforcing path below.
    if (isPageRequest && context.isPrerendered !== true) {
      let sessionContext: Awaited<ReturnType<typeof currentSessionContext>> = null;
      const cookieHeader = context.request.headers.get("cookie");

      try {
        sessionContext = await currentSessionContext(cookieHeader);
      } catch {
        sessionContext = null;
      }

      let board: Awaited<ReturnType<typeof readBoard>> | null = null;
      let boardFailed = false;

      try {
        board = await readBoard(readSql());
      } catch {
        boardFailed = true;
      }

      if (sessionContext !== null) {
        context.locals.locale = sessionContext.locale;
        context.locals.localeSource = "member";
      } else {
        const bp = parseCookieHeader(cookieHeader)[BP_COOKIE_NAME];
        const resolution = resolveRequestLocale({
          audience: "guest",
          bp: bp ?? null,
          boardDefaultLocale: board?.defaultLocale ?? null,
          acceptLanguage: context.request.headers.get("accept-language"),
        });
        context.locals.locale = resolution.locale;
        context.locals.localeSource = "guest";
      }

      if (board !== null) {
        context.locals.board = board;
      }

      context.locals.session = sessionContext;

      if (
        isNavigation &&
        shouldRedirectToReauth({
          method: "GET",
          secFetchMode: "navigate",
          pathname: context.url.pathname,
          reauthAt: sessionContext?.reauthAt ?? null,
        })
      ) {
        return secure(
          context.redirect(reauthRedirectUrl(`${context.url.pathname}${context.url.search}`), 303),
        );
      }

      // ADR 0005: a member without a display name must choose one before browsing.
      if (
        isNavigation &&
        sessionContext !== null &&
        sessionContext.displayName === null &&
        context.url.pathname !== DISPLAY_NAME_PATH
      ) {
        const returnTo = `${context.url.pathname}${context.url.search}`;
        return secure(
          context.redirect(`${DISPLAY_NAME_PATH}?return_to=${encodeURIComponent(returnTo)}`, 303),
        );
      }

      // Fail closed: if the board state cannot be read, do not serve the forum.
      if (boardFailed) {
        return secure(
          offlinePage({
            locale: context.locals.locale ?? "en",
            nonce,
            message: "",
            returnTo: `${context.url.pathname}${context.url.search}`,
          }),
        );
      }

      if (board?.offline === true) {
        let allowed = false;

        if (sessionContext !== null) {
          try {
            allowed = await canViewOffline(readSql(), sessionContext.memberId);
          } catch {
            allowed = false;
          }
        }

        if (!allowed) {
          return secure(
            offlinePage({
              locale: context.locals.locale ?? "en",
              nonce,
              message: board.offlineMessage,
              returnTo: `${context.url.pathname}${context.url.search}`,
            }),
          );
        }
      }
    }

    return secure(await next());
  } finally {
    finish?.();
  }
});
