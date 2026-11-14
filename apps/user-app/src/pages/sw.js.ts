import type { APIRoute } from "astro";
import { pwaBuild } from "../pwa/build.ts";
import { serviceWorkerSource } from "../pwa/service-worker.ts";

/** `GET /sw.js`: the versioned service worker (ADR 0014), served from the app's root scope. */
export const GET: APIRoute = async () => {
  const build = await pwaBuild();

  return new Response(serviceWorkerSource(build), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // Updates are checked on every registration; never let a stale worker script be cached.
      "cache-control": "no-cache",
      "service-worker-allowed": "/",
      "x-content-type-options": "nosniff",
    },
  });
};
