import { requireFlag } from "@bulletin/flags";
import type { SQL } from "bun";
import { createUserFlags, loadFlagViewer } from "../flags.ts";
import { readSessionContext } from "../session.ts";

/**
 * Feature-flag guard for the user-app's own endpoints (manifest, icons, service worker). A
 * disabled feature answers 404, exactly like a JSON route using `requireFlag` (ADR 0010).
 */
export function pwaFlagRoute(
  sql: SQL,
  request: Request,
  key: "pwa" | "web_push",
  next: () => Response | Promise<Response>,
): Promise<Response> {
  const viewer = readSessionContext(sql, request.headers.get("cookie"))
    .catch(() => null)
    .then((session) => loadFlagViewer(sql, session));

  return requireFlag(key, {
    runtime: createUserFlags(sql),
    viewer: () => viewer,
  })(request, next);
}
