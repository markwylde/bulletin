import { defineMiddleware } from "astro:middleware";
import { createDrainController } from "@bulletin/config/drain";

const userApiUrl = process.env.USER_API_INTERNAL_URL ?? "http://user-api:3001";
const drain = import.meta.env.DEV ? createDrainController() : null;

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

    return await next();
  } finally {
    finish?.();
  }
});
