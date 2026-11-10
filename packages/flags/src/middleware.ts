import type { FlagRuntime } from "./runtime.ts";
import type { FlagViewer } from "./types.ts";

export type FlagRouteHandler = () => Response | Promise<Response>;

/**
 * Route middleware: `requireFlag(key, guard)(request, next)` runs `next` only when the flag is
 * on for the requester, otherwise answers 404 so a disabled feature is indistinguishable from
 * one that does not exist (spec `feature-flags`, server-side enforcement).
 */
export type FlagRoute = (request: Request, next: FlagRouteHandler) => Promise<Response>;

export interface FlagGuard {
  readonly runtime: FlagRuntime;
  /** Resolves the requester; return `GUEST_VIEWER` when unauthenticated. */
  viewer(request: Request): FlagViewer | Promise<FlagViewer>;
}

export interface RequireFlagOptions {
  /** Override the response for a disabled feature; defaults to a plain JSON 404. */
  readonly onDenied?: () => Response;
}

export function flagNotFound(): Response {
  return Response.json(
    { code: "not_found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

export function requireFlag(
  key: string,
  guard: FlagGuard,
  options: RequireFlagOptions = {},
): FlagRoute {
  const denied = options.onDenied ?? flagNotFound;

  return async (request, next) => {
    const [viewer] = await Promise.all([guard.viewer(request), guard.runtime.ensureFresh()]);

    if (!guard.runtime.isOn(viewer, key)) {
      return denied();
    }

    return next();
  };
}
