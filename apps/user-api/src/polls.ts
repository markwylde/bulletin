import {
  editPoll,
  type PollErrorCode,
  parsePollInput,
  pollResults,
  vote,
} from "@bulletin/domain/polls";
import type { SQL } from "bun";

interface Session {
  readonly memberId: string;
}

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function bodyRecord(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);

  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function failure(code: PollErrorCode): Response {
  const status =
    code === "forbidden"
      ? 403
      : code === "not_found"
        ? 404
        : code === "already_voted" || code === "closed"
          ? 409
          : 400;

  return json({ code }, status);
}

function parseSelections(value: unknown): Array<{
  readonly questionId: string;
  readonly choiceIds: string[];
}> | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const result: Array<{ questionId: string; choiceIds: string[] }> = [];

  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }

    const record = raw as Record<string, unknown>;
    const questionId = record.questionId;
    const choiceIds = record.choiceIds;

    if (
      typeof questionId !== "string" ||
      !/^\d+$/.test(questionId) ||
      !Array.isArray(choiceIds) ||
      choiceIds.length === 0 ||
      !choiceIds.every((id): id is string => typeof id === "string" && /^\d+$/.test(id))
    ) {
      return null;
    }

    result.push({ questionId, choiceIds });
  }

  return result;
}

/** `POST /api/polls/<id>/vote` (task 4.1). */
export async function pollVoteResponse(
  sql: SQL,
  session: Session,
  pollId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);
  const selections = parseSelections(body?.selections);

  if (selections === null) {
    return json({ code: "invalid_choice" }, 400);
  }

  const result = await vote(sql, { actorId: session.memberId, pollId, selections });
  return result.ok ? json({ ok: true, ...result.result }) : failure(result.code);
}

/** `GET /api/polls/<id>/results`; private and checked per request (task 4.2). */
export async function pollResultsResponse(
  sql: SQL,
  session: Session | null,
  pollId: string,
): Promise<Response> {
  if (session === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  const result = await pollResults(sql, { pollId, actorId: session.memberId });
  return result.ok ? json(result.result) : failure(result.code);
}

/** `POST /api/polls/<id>/edit` (task 4.1 poll editing). */
export async function pollEditResponse(
  sql: SQL,
  session: Session,
  pollId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);
  const poll = parsePollInput(body?.poll);

  if (poll === null) {
    return json({ code: "invalid_poll" }, 400);
  }

  const result = await editPoll(sql, {
    actorId: session.memberId,
    pollId,
    poll,
    ...(body?.confirmRemoveVoted === true ? { confirmRemoveVoted: true } : {}),
  });

  return result.ok ? json({ ok: true, ...result.result }) : failure(result.code);
}
