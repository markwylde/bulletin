import { requireFlag } from "@bulletin/flags";
import type { SQL } from "bun";
import { createUserFlags, loadFlagViewer } from "../flags.ts";
import { readSessionContext } from "../session.ts";

/**
 * Server-side `feeds` gate (ADR 0010): a disabled feed is indistinguishable from one that does
 * not exist. Sitemaps and canonical URLs stay core and are not behind this flag.
 */
export function feedsFlagRoute(
  sql: SQL,
  request: Request,
  next: () => Response | Promise<Response>,
): Promise<Response> {
  const viewer = readSessionContext(sql, request.headers.get("cookie"))
    .catch(() => null)
    .then((session) => loadFlagViewer(sql, session));

  return requireFlag(
    "feeds",
    { runtime: createUserFlags(sql), viewer: () => viewer },
    {
      onDenied: () =>
        new Response("", {
          status: 404,
          headers: {
            "cache-control": "no-store",
            "content-type": "text/plain; charset=utf-8",
          },
        }),
    },
  )(request, next);
}
