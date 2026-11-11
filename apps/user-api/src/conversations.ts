import {
  readConversationForParticipant,
  type StartConversationFailure,
  startConversation,
} from "@bulletin/domain/conversations";
import type { SQL } from "bun";

/** Conversation responses are never storable, by any shared or private cache (design). */
const NO_STORE = { "cache-control": "private, no-store" } as const;

interface Session {
  readonly memberId: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function bodyRecord(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);

  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function failure(outcome: StartConversationFailure): Response {
  switch (outcome.code) {
    case "recipient_limit":
      return json({ code: outcome.code, limit: outcome.limit }, 400);
    case "daily_limit":
      return json(
        {
          code: outcome.code,
          limit: outcome.limit,
          retryAfterSeconds: outcome.retryAfterSeconds,
        },
        429,
      );
    case "quota_reached":
      return json({ code: outcome.code, quota: outcome.quota }, 409);
    case "pm_disabled":
    case "recipient_unavailable":
      return json({ code: outcome.code }, 403);
    default:
      return json({ code: outcome.code }, 400);
  }
}

/** `POST /api/conversations` (task 1.2). */
export async function createConversationResponse(
  sql: SQL,
  session: Session,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (
    body === null ||
    typeof body.title !== "string" ||
    typeof body.bodyMd !== "string" ||
    !Array.isArray(body.recipientIds) ||
    !body.recipientIds.every((value) => typeof value === "string")
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  const outcome = await startConversation(sql, {
    actorId: session.memberId,
    title: body.title,
    bodyMd: body.bodyMd,
    recipientIds: body.recipientIds as readonly string[],
  });

  if (!outcome.ok) {
    return failure(outcome);
  }

  return json({ ok: true, ...outcome.result });
}

/** `GET /api/conversations/<id>`: participants only; unknown and unauthorised both 404. */
export async function conversationResponse(
  sql: SQL,
  session: Session,
  conversationId: string,
): Promise<Response> {
  const conversation = await readConversationForParticipant(sql, conversationId, session.memberId);

  return conversation === null ? json({ code: "not_found" }, 404) : json(conversation);
}
