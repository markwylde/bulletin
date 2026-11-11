import type { SessionRecord } from "@bulletin/domain/auth";
import {
  type FollowKind,
  follow,
  isFollowKind,
  setAutoFollowTopics,
  unfollow,
} from "@bulletin/domain/follows";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;
const ID = /^[1-9]\d{0,18}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `POST /api/follows`: follow or unfollow one topic, forum or member. */
export async function followResponse(
  sql: SQL,
  session: SessionRecord,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (
    !isRecord(body) ||
    typeof body.kind !== "string" ||
    !isFollowKind(body.kind) ||
    typeof body.id !== "string" ||
    !ID.test(body.id) ||
    typeof body.following !== "boolean"
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  const kind: FollowKind = body.kind;

  if (body.following) {
    const outcome = await follow(sql, {
      memberId: session.memberId,
      kind,
      id: body.id,
      sessionId: session.id,
    });

    if (!outcome.ok) {
      return outcome.code === "not_found"
        ? json({ code: "not_found" }, 404)
        : json({ code: "cannot_follow_self" }, 400);
    }
  } else {
    await unfollow(sql, { memberId: session.memberId, kind, id: body.id });
  }

  return json({ ok: true, following: body.following });
}

/** `POST /api/me/follow-settings`: the auto-follow-on-participation preference. */
export async function followSettingsResponse(
  sql: SQL,
  session: SessionRecord,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body) || typeof body.autoFollowTopics !== "boolean") {
    return json({ code: "invalid_request" }, 400);
  }

  await setAutoFollowTopics(sql, session.memberId, body.autoFollowTopics);

  return json({ ok: true, autoFollowTopics: body.autoFollowTopics });
}
