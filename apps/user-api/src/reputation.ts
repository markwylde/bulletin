import { evaluatePromotion } from "@bulletin/db/jobs";
import { giveReputation, type ReputationErrorCode } from "@bulletin/domain/reputation";
import type { SQL } from "bun";

interface Session {
  readonly memberId: string;
  readonly id?: string;
  readonly sessionId?: string;
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

function failure(
  code: ReputationErrorCode,
  details: { resetsAt?: Date; minPosts?: number },
): Response {
  const status =
    code === "not_found"
      ? 404
      : code === "already_given"
        ? 409
        : code === "daily_limit"
          ? 429
          : 403;

  return json(
    {
      code,
      ...(details.resetsAt === undefined ? {} : { resetsAt: details.resetsAt.toISOString() }),
      ...(details.minPosts === undefined ? {} : { minPosts: details.minPosts }),
    },
    status,
  );
}

/**
 * `POST /api/posts/<id>/reputation` (reputation spec): `{points: 1 | -1}`. The route only
 * carries the request; every rule lives in `giveReputation`, and a change re-evaluates the
 * receiver's promotion rules (reputation is a promotion criterion).
 */
export async function reputationGiveResponse(
  sql: SQL,
  session: Session,
  postId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);
  const points = body?.points;

  if (points !== 1 && points !== -1) {
    return json({ code: "invalid_points" }, 400);
  }

  const result = await giveReputation(sql, {
    actorId: session.memberId,
    postId,
    points,
    sessionId: session.id ?? session.sessionId ?? null,
  });

  if (!result.ok) {
    return failure(result.code, {
      ...(result.resetsAt === undefined ? {} : { resetsAt: result.resetsAt }),
      ...(result.minPosts === undefined ? {} : { minPosts: result.minPosts }),
    });
  }

  await evaluatePromotion(sql, result.result.receiverId).catch(() => undefined);

  return json({
    ok: true,
    points: result.result.points,
    total: result.result.total,
  });
}
