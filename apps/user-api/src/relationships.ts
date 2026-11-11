import type { SessionRecord } from "@bulletin/domain/auth";
import {
  ignoreMember,
  readMemberRelationshipState,
  removeFriend,
  respondToFriendRequest,
  sendFriendRequest,
  unignoreMember,
} from "@bulletin/domain/relationships";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;
const MEMBER_ID = /^[1-9]\d{0,18}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `GET /api/relationships/state?memberId=`: the viewer's friend and ignore state. */
export async function relationshipStateResponse(
  sql: SQL,
  session: SessionRecord,
  url: URL,
): Promise<Response> {
  const memberId = url.searchParams.get("memberId") ?? "";

  if (!MEMBER_ID.test(memberId)) {
    return json({ code: "invalid" }, 400);
  }

  const state = await readMemberRelationshipState(sql, session.memberId, memberId);

  return state === null ? json({ code: "not_found" }, 404) : json(state);
}

/** `POST /api/ignores`: add or remove one member from the viewer's private ignore list. */
export async function ignoreResponse(
  sql: SQL,
  session: SessionRecord,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (
    !isRecord(body) ||
    typeof body.memberId !== "string" ||
    !MEMBER_ID.test(body.memberId) ||
    typeof body.ignoring !== "boolean"
  ) {
    return json({ code: "invalid" }, 400);
  }

  const result = body.ignoring
    ? await ignoreMember(sql, { memberId: session.memberId, ignoredId: body.memberId })
    : await unignoreMember(sql, { memberId: session.memberId, ignoredId: body.memberId });

  if (!result.ok) {
    const status = result.code === "unignorable" || result.code === "blocked" ? 403 : 400;
    return json({ code: result.code }, status);
  }

  return json({ ok: true, ignoring: body.ignoring });
}

/** `POST /api/friends`: request, accept, decline or remove a friendship. */
export async function friendResponse(
  sql: SQL,
  session: SessionRecord,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body) || typeof body.action !== "string") {
    return json({ code: "invalid" }, 400);
  }

  const memberId = typeof body.memberId === "string" ? body.memberId : "";
  const requesterId = typeof body.requesterId === "string" ? body.requesterId : "";

  switch (body.action) {
    case "request":
    case "remove": {
      if (!MEMBER_ID.test(memberId)) {
        return json({ code: "invalid" }, 400);
      }

      const result =
        body.action === "request"
          ? await sendFriendRequest(sql, { memberId: session.memberId, targetId: memberId })
          : await removeFriend(sql, { memberId: session.memberId, friendId: memberId });

      if (!result.ok) {
        return json({ code: result.code }, result.code === "blocked" ? 403 : 409);
      }

      return json({ ok: true });
    }
    case "accept":
    case "decline": {
      if (!MEMBER_ID.test(requesterId)) {
        return json({ code: "invalid" }, 400);
      }

      const result = await respondToFriendRequest(sql, {
        memberId: session.memberId,
        requesterId,
        accept: body.action === "accept",
      });

      return result.ok ? json({ ok: true }) : json({ code: result.code }, 409);
    }
    default:
      return json({ code: "invalid" }, 400);
  }
}
