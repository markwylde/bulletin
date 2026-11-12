import {
  type ConversationParticipantFailure,
  inviteConversationParticipant,
  isConversationMessageReadable,
  leaveConversation,
  markConversationRead,
  readConversationForParticipant,
  refreshConversationMessagesForRead,
  removeConversationParticipant,
  replyToConversation,
  type StartConversationFailure,
  setParticipantFolder,
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

  if (conversation === null) {
    return json({ code: "not_found" }, 404);
  }

  return json({
    ...conversation,
    messages: await refreshConversationMessagesForRead(sql, conversation.messages),
  });
}

function participantFailure(outcome: ConversationParticipantFailure): Response {
  switch (outcome.code) {
    case "recipient_limit":
      return json({ code: outcome.code, limit: outcome.limit }, 400);
    case "not_found":
      return json({ code: outcome.code }, 404);
    case "already_participant":
      return json({ code: outcome.code }, 409);
    case "forbidden":
    case "pm_disabled":
    case "recipient_unavailable":
    case "invite_blocked":
      return json({ code: outcome.code }, 403);
    default:
      return json({ code: outcome.code }, 400);
  }
}

/** `POST /api/conversations/<id>/replies` (task 2.1). */
export async function replyConversationResponse(
  sql: SQL,
  session: Session,
  conversationId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body === null || typeof body.bodyMd !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  const outcome = await replyToConversation(sql, {
    actorId: session.memberId,
    conversationId,
    bodyMd: body.bodyMd,
  });

  if (!outcome.ok) {
    if (outcome.code === "not_found") {
      return json({ code: outcome.code }, 404);
    }

    return json({ code: outcome.code }, outcome.code === "pm_disabled" ? 403 : 400);
  }

  return json({ ok: true, ...outcome.result });
}

/** `POST /api/conversations/<id>/participants` with `{action:"invite"|"remove", memberId}`. */
export async function participantResponse(
  sql: SQL,
  session: Session,
  conversationId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);
  const action = body?.action;
  const memberId = typeof body?.memberId === "string" ? body.memberId : "";

  if (body === null || (action !== "invite" && action !== "remove")) {
    return json({ code: "invalid_request" }, 400);
  }

  const outcome =
    action === "invite"
      ? await inviteConversationParticipant(sql, {
          actorId: session.memberId,
          conversationId,
          memberId,
        })
      : await removeConversationParticipant(sql, {
          actorId: session.memberId,
          conversationId,
          memberId,
        });

  return outcome.ok ? json({ ok: true }) : participantFailure(outcome);
}

/** `POST /api/conversations/<id>/leave` (task 2.1); access ends immediately. */
export async function leaveConversationResponse(
  sql: SQL,
  session: Session,
  conversationId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);
  const blockReinvite = body?.blockReinvite === true;
  const outcome = await leaveConversation(sql, {
    actorId: session.memberId,
    conversationId,
    blockReinvite,
  });

  return outcome.ok ? json({ ok: true }) : participantFailure(outcome);
}

/** `POST /api/conversations/<id>/archive` with `{archived: boolean}` (task 2.2). */
export async function archiveConversationResponse(
  sql: SQL,
  session: Session,
  conversationId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body === null || typeof body.archived !== "boolean") {
    return json({ code: "invalid_request" }, 400);
  }

  const folder = body.archived ? "archive" : "inbox";
  const updated = await setParticipantFolder(sql, conversationId, session.memberId, folder);

  return updated ? json({ ok: true, folder }) : json({ code: "not_found" }, 404);
}

/** `POST /api/conversations/<id>/read`: advances the member's read marker (task 2.2). */
export async function readConversationResponse(
  sql: SQL,
  session: Session,
  conversationId: string,
  request?: Request,
): Promise<Response> {
  const body = request === undefined ? null : await bodyRecord(request);
  const messageId = typeof body?.messageId === "string" ? body.messageId : null;

  if (messageId !== null) {
    if (
      !/^\d+$/.test(messageId) ||
      !(await isConversationMessageReadable(sql, conversationId, messageId, session.memberId))
    ) {
      return json({ code: "not_found" }, 404);
    }
  }

  const updated = await markConversationRead(sql, conversationId, session.memberId, messageId);

  return updated ? json({ ok: true }) : json({ code: "not_found" }, 404);
}
