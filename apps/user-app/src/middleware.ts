import { defineMiddleware } from "astro:middleware";
import { createDrainController } from "@bulletin/config/drain";
import { routeLabel, standardMetrics } from "@bulletin/config/metrics";
import { applySecurityHeaders, createCspNonce } from "@bulletin/config/security";
import { withServerSpan } from "@bulletin/config/tracing";
import { parseCookieHeader } from "@bulletin/domain/auth";
import { reauthRedirectUrl, shouldRedirectToReauth } from "@bulletin/domain/auth/silent";
import { embedProviderOrigins, listEmbedProviders } from "@bulletin/domain/content";
import {
  BP_COOKIE_MAX_AGE_SECONDS,
  BP_COOKIE_NAME,
  DEFAULT_BP_THEME_ID,
  resolveRequestLocale,
  serializeBpCookie,
} from "@bulletin/i18n";
import type { APIContext, MiddlewareNext } from "astro";
import { canViewOffline, readBoard } from "./board.ts";
import { closeCacheRuntime } from "./cache-runtime.ts";
import { readSql } from "./db.ts";
import { loadViewerFlags } from "./flags.ts";
import { startUserAppMetrics } from "./observability.ts";
import { offlinePage } from "./offline.ts";
import { configuredPluginOrigin } from "./plugins/config.ts";
import { closeSessionReadPool, currentSessionContext } from "./session.ts";
import { resolveRequestTheme } from "./theme/request-theme.ts";

const userApiUrl = process.env.USER_API_INTERNAL_URL ?? "http://user-api:3001";
const authIssuer =
  process.env.BULLETIN_AUTH_ISSUER ??
  `http://auth.bulletin.localhost:${process.env.BULLETIN_HTTP_PORT ?? "8080"}`;
const filesOrigin =
  process.env.BULLETIN_FILES_ORIGIN ??
  `http://files.bulletin.localhost:${process.env.BULLETIN_HTTP_PORT ?? "8080"}`;
const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development";
const drain = import.meta.env.DEV ? createDrainController() : null;

startUserAppMetrics();

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
  "/theme-css",
  "/theme-assets/",
  // The PWA manifest, generated icons and service worker are not themed pages.
  "/manifest.webmanifest",
  "/sw.js",
  "/pwa/",
  // Sitemaps and RSS/Atom feeds are public XML documents, always evaluated as Guests; their
  // routes apply the offline gate themselves (503 unless Guests may view offline). robots.txt
  // stays available so crawlers keep their rules while the board is offline.
  "/sitemap",
  "/feed",
  "/robots.txt",
];
const DISPLAY_NAME_PATH = "/display-name";
/** The service worker's offline fallback must load for every visitor, even mid-redirect. */
const OFFLINE_SHELL_PATH = "/offline";

if (import.meta.env.DEV) {
  process.once("SIGTERM", () => {
    void drain?.drain(Number(process.env.BULLETIN_DRAIN_TIMEOUT_MS ?? 25_000)).finally(() => {
      void closeCacheRuntime();
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
  const started = performance.now();
  let status = 500;

  const route = context.routePattern || routeLabel(context.url.pathname);

  try {
    const response = await withServerSpan(
      context.request,
      `${context.request.method} ${route}`,
      async (span) => {
        const result = await handle(context, next);
        span.setAttribute("http.response.status_code", result.status);
        return result;
      },
      { "http.route": route, "service.name": "user-app" },
    );
    status = response.status;
    return response;
  } finally {
    if (!context.url.pathname.startsWith("/health/")) {
      standardMetrics.requestDuration.observe(
        {
          route,
          method: context.request.method,
          status: String(status),
        },
        (performance.now() - started) / 1_000,
      );
    }
  }
});

async function handle(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const finish = drain?.track();
  const nonce = createCspNonce();
  context.locals.cspNonce = nonce;
  // Populated for page requests once the allowlisted embed providers are known. APIs and
  // health checks frame nothing, so they keep the default `none`.
  let frameSrc: readonly string[] = [];
  const secure = (response: Response): Response =>
    applySecurityHeaders(response, {
      nonce,
      nodeEnv,
      // Presigned uploads go directly to the files origin (ADR 0019), so it is also a connect
      // target; downloaded images come back through the same origin's redirect.
      connectSrc: [authIssuer, filesOrigin],
      frameSrc,
      imgSrc: [filesOrigin],
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

      // The content pipeline only embeds allowlisted providers, so their exact origins are
      // the only frames the page may load (ADR 0018). A provider read failure fails closed.
      frameSrc = [
        ...embedProviderOrigins(await listEmbedProviders(readSql()).catch(() => [])),
        // Plugin client apps are framed from the separate plugin origin (ADR 0009, 0018).
        configuredPluginOrigin(),
      ];

      if (sessionContext !== null) {
        context.locals.locale = sessionContext.locale;
        context.locals.localeSource = "member";
      } else {
        const bpValue = parseCookieHeader(cookieHeader)[BP_COOKIE_NAME];
        // `?lang=` is part of the URL, so the CDN key (URL + `bp`) and the origin variant key
        // (which includes the locale) already separate it; it never touches the cookie.
        const resolution = resolveRequestLocale({
          audience: "guest",
          bp: bpValue ?? null,
          query: context.url.searchParams.get("lang"),
          boardDefaultLocale: board?.defaultLocale ?? null,
          acceptLanguage: context.request.headers.get("accept-language"),
        });
        context.locals.locale = resolution.locale;
        context.locals.localeSource = "guest";
        context.locals.localeFromQuery = resolution.source === "query";
      }

      const requestedTheme = await resolveRequestTheme(readSql(), cookieHeader, sessionContext);
      context.locals.themeId = requestedTheme.themeId;
      context.locals.previewTheme = requestedTheme.preview;
      context.locals.colourScheme = requestedTheme.scheme;

      if (requestedTheme.invalidGuestTheme) {
        // A one-off `?lang=` view never becomes the guest's saved preference.
        const locale =
          context.locals.localeFromQuery === true
            ? resolveRequestLocale({
                audience: "guest",
                bp: parseCookieHeader(cookieHeader)[BP_COOKIE_NAME] ?? null,
                boardDefaultLocale: board?.defaultLocale ?? null,
              }).locale
            : (context.locals.locale ?? "en");
        context.locals.resetThemeCookie = `${BP_COOKIE_NAME}=${serializeBpCookie({
          locale,
          themeId: DEFAULT_BP_THEME_ID,
          scheme: requestedTheme.scheme,
        })}; Path=/; Max-Age=${BP_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
      }

      if (board !== null) {
        context.locals.board = board;
      }

      context.locals.session = sessionContext;

      try {
        context.locals.clientFlags = (await loadViewerFlags(readSql(), sessionContext)).clientFlags;
      } catch {
        context.locals.clientFlags = {};
      }

      if (
        isNavigation &&
        context.url.pathname !== OFFLINE_SHELL_PATH &&
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
        context.url.pathname !== DISPLAY_NAME_PATH &&
        context.url.pathname !== OFFLINE_SHELL_PATH
      ) {
        const returnTo = `${context.url.pathname}${context.url.search}`;
        return secure(
          context.redirect(`${DISPLAY_NAME_PATH}?return_to=${encodeURIComponent(returnTo)}`, 303),
        );
      }

      // Fail closed: if the board state cannot be read, do not serve the forum. The cached
      // offline shell is the exception, so the PWA can still explain an outage.
      if (boardFailed && context.url.pathname !== OFFLINE_SHELL_PATH) {
        return secure(
          offlinePage({
            locale: context.locals.locale ?? "en",
            nonce,
            message: "",
            returnTo: `${context.url.pathname}${context.url.search}`,
          }),
        );
      }

      if (board?.offline === true && context.url.pathname !== OFFLINE_SHELL_PATH) {
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

    const response = secure(await next());

    if (context.locals.resetThemeCookie !== undefined) {
      response.headers.append("set-cookie", context.locals.resetThemeCookie);
    }

    return response;
  } finally {
    finish?.();
  }
}
