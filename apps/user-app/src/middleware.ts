import { defineMiddleware } from "astro:middleware";
import { createDrainController } from "@bulletin/config/drain";
import { reauthRedirectUrl, shouldRedirectToReauth } from "@bulletin/domain/auth/silent";

const userApiUrl = process.env.USER_API_INTERNAL_URL ?? "http://user-api:3001";
const drain = import.meta.env.DEV ? createDrainController() : null;

const NON_PAGE_PREFIXES = ["/api/", "/health/", "/auth/", "/_", "/@", "/src/"];

if (import.meta.env.DEV) {
  process.once("SIGTERM", () => {
    void drain
      ?.drain(Number(process.env.BULLETIN_DRAIN_TIMEOUT_MS ?? 25_000))
      .finally(() => process.exit(0));
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

interface SessionProbe {
  readonly authenticated?: boolean;
  readonly reauthAt?: string | null;
}

async function navigationNeedsReauth(pathname: string, cookie: string | null): Promise<boolean> {
  try {
    const response = await fetch(`${userApiUrl}/api/auth/session`, {
      headers: {
        accept: "application/json",
        ...(cookie === null ? {} : { cookie }),
      },
    });

    if (!response.ok) {
      return false;
    }

    const session = (await response.json()) as SessionProbe;

    return shouldRedirectToReauth({
      method: "GET",
      secFetchMode: "navigate",
      pathname,
      reauthAt: session.authenticated === true ? (session.reauthAt ?? null) : null,
    });
  } catch {
    return false;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const finish = drain?.track();

  try {
    if (context.url.pathname === "/health/live") {
      return Response.json({ status: "ok", service: "user-app" });
    }

    if (context.url.pathname === "/health/ready") {
      if (drain?.draining === true) {
        return Response.json({ status: "draining", checks: {} }, { status: 503 });
      }

      const result = await readiness();
      return Response.json(result.body, { status: result.status });
    }

    const isNavigation =
      context.request.method === "GET" &&
      context.request.headers.get("sec-fetch-mode") === "navigate";

    if (
      isNavigation &&
      !NON_PAGE_PREFIXES.some((prefix) => context.url.pathname.startsWith(prefix))
    ) {
      if (
        await navigationNeedsReauth(context.url.pathname, context.request.headers.get("cookie"))
      ) {
        return context.redirect(
          reauthRedirectUrl(`${context.url.pathname}${context.url.search}`),
          303,
        );
      }
    }

    return await next();
  } finally {
    finish?.();
  }
});
