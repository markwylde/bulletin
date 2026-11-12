import { evaluatePromotion } from "@bulletin/db/jobs";
import type { SessionRecord } from "@bulletin/domain/auth";
import {
  approveHeldPosts,
  listApprovalQueue,
  pendingApprovalCount,
  rejectHeldPosts,
} from "@bulletin/domain/moderation";
import type { SQL } from "bun";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function intParameter(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export async function staffQueueResponse(
  sql: SQL,
  session: SessionRecord,
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
    sessionId: session.id,
    ...(forumId !== null && /^\d+$/.test(forumId) ? { forumId } : {}),
  });

  return json({
    total: queue.total,
    forums: queue.forums,
    items: queue.items.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
    })),
  });
}

export async function staffQueueCountResponse(sql: SQL, session: SessionRecord): Promise<Response> {
  return json({ count: await pendingApprovalCount(sql, session.memberId, session.id) });
}

export async function staffModerationActionResponse(
  sql: SQL,
  session: SessionRecord,
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

  const input = { actorId: session.memberId, postIds, sessionId: session.id };
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
