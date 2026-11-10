import { unlockForum } from "@bulletin/domain/permissions";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

/** The only session fields the route needs; a `SessionRecord` is structurally compatible. */
export interface UnlockSession {
  readonly id: string;
  readonly memberId: string;
}

async function readPassword(request: Request): Promise<string | null> {
  const text = await request.text();

  if (text.trim() === "") {
    return null;
  }

  try {
    const value: unknown = JSON.parse(text);

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }

    const password = (value as Record<string, unknown>).password;
    return typeof password === "string" && password.length > 0 ? password : null;
  } catch {
    return null;
  }
}

/**
 * `POST /api/forums/<id>/unlock` (ADR 0005, 0018). The auth service has already checked the
 * origin, the CSRF token and the session before this runs.
 */
export async function forumUnlockResponse(
  sql: SQL,
  session: UnlockSession,
  forumId: string,
  request: Request,
): Promise<Response> {
  const password = await readPassword(request);

  if (password === null) {
    return Response.json({ code: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const result = await unlockForum(sql, {
    sessionId: session.id,
    memberId: session.memberId,
    forumId,
    password,
  });

  switch (result.kind) {
    case "unlocked":
      return Response.json({ unlocked: true }, { headers: NO_STORE });
    case "wrong_password":
      return Response.json({ code: "wrong_password" }, { status: 403, headers: NO_STORE });
    case "throttled": {
      const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1_000);
      return Response.json(
        { code: "throttled", retryAfterSeconds },
        {
          status: 429,
          headers: { ...NO_STORE, "retry-after": String(retryAfterSeconds) },
        },
      );
    }
    case "forbidden":
      return Response.json({ code: "forbidden" }, { status: 403, headers: NO_STORE });
    case "no_password":
      return Response.json({ code: "forum_has_no_password" }, { status: 409, headers: NO_STORE });
    case "not_found":
      return Response.json({ code: "not_found" }, { status: 404, headers: NO_STORE });
  }
}
