import type { APIRoute } from "astro";
import { USER_CATALOGS } from "../catalogs.ts";
import { readSql } from "../db.ts";
import { pwaBuild } from "../pwa/build.ts";
import { pwaFlagRoute } from "../pwa/guard.ts";
import { serviceWorkerSource } from "../pwa/service-worker.ts";

function pushTitles(): Readonly<Record<string, Readonly<Record<string, string>>>> {
  return Object.fromEntries(
    Object.entries(USER_CATALOGS).map(([locale, catalog]) => [
      locale,
      Object.fromEntries(Object.entries(catalog).filter(([key]) => key.startsWith("push.title."))),
    ]),
  );
}

/** `GET /sw.js`: the versioned service worker (ADR 0014), served from the app's root scope. */
export const GET: APIRoute = ({ request }) =>
  pwaFlagRoute(readSql(), request, "pwa", () => serviceWorkerResponse());

async function serviceWorkerResponse(): Promise<Response> {
  const build = await pwaBuild();

  return new Response(serviceWorkerSource({ ...build, titles: pushTitles() }), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // Updates are checked on every registration; never let a stale worker script be cached.
      "cache-control": "no-cache",
      "service-worker-allowed": "/",
      "x-content-type-options": "nosniff",
    },
  });
}
