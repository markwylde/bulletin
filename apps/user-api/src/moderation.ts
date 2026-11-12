import { evaluatePromotion } from "@bulletin/db/jobs";
import {
  approveHeldPosts,
  listApprovalQueue,
  pendingApprovalCount,
  rejectHeldPosts,
} from "@bulletin/domain/moderation";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

interface Session {
  readonly memberId: string;
  readonly id?: string;
  readonly sessionId?: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function intParameter(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** `GET /api/moderation/queue` (moderation queue spec). */
export async function queueResponse(
  sql: SQL,
  session: Session,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const limit = intParameter(url.searchParams.get("limit"), 50, 1, 100);
  const offset = intParameter(url.searchParams.get("offset"), 0, 0, 10_000);
  const forumId = url.searchParams.get("forumId");
  const queue = await listApprovalQueue(sql, {
    actorId: session.memberId,
    limit,
    offset,
    sessionId: session.id ?? session.sessionId ?? null,
    ...(forumId !== null && /^\d+$/.test(forumId) ? { forumId } : {}),
  });

  if (queue.forums.length === 0) {
    return json({ code: "forbidden" }, 403);
  }

  return json({
    total: queue.total,
    forums: queue.forums,
    items: queue.items.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
    })),
  });
}

/** `GET /api/moderation/count`; the queue page polls this for a live badge. */
export async function queueCountResponse(sql: SQL, session: Session): Promise<Response> {
  return json({
    count: await pendingApprovalCount(
      sql,
      session.memberId,
      session.id ?? session.sessionId ?? null,
    ),
  });
}

/** `POST /api/moderation/actions` with `approve` or `reject` and a list of post ids. */
export async function moderationActionResponse(
  sql: SQL,
  session: Session,
  request: Request,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (body === null || (body.action !== "approve" && body.action !== "reject")) {
    return json({ code: "invalid_request" }, 400);
  }

  const postIds = Array.isArray(body.postIds)
    ? body.postIds.filter((id): id is string => typeof id === "string")
    : [];

  if (postIds.length === 0) {
    return json({ code: "invalid_request" }, 400);
  }

  const input = {
    actorId: session.memberId,
    postIds,
    sessionId: session.id ?? session.sessionId ?? null,
  };
  const result =
    body.action === "approve"
      ? await approveHeldPosts(sql, input)
      : await rejectHeldPosts(sql, input);

  if (!result.ok) {
    return json({ code: result.code }, result.code === "forbidden" ? 403 : 400);
  }

  if (body.action === "approve") {
    for (const authorId of result.result.authorIds) {
      await evaluatePromotion(sql, authorId).catch(() => undefined);
    }
  }

  return json({ ok: true, postIds: result.result.postIds });
}
