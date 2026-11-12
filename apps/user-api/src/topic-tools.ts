import {
  applyMultimod,
  type BulkInput,
  type BulkPostAction,
  type BulkTopicAction,
  bulkAction,
  lock,
  mergeTopics,
  move,
  pin,
  splitTopic,
  type TopicMutationCode,
  type TopicMutationOutcome,
} from "@bulletin/domain/topics";
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

async function bodyRecord(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);

  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function failure(code: TopicMutationCode | string): Response {
  const status =
    code === "forbidden"
      ? 403
      : code === "topic_not_found" || code === "post_not_found" || code === "forum_not_found"
        ? 404
        : code === "locked" || code === "first_post_requires_topic_delete"
          ? 409
          : 400;

  return json({ code }, status);
}

function sessionId(session: Session): string | null {
  return session.id ?? session.sessionId ?? null;
}

function outcome<T>(result: TopicMutationOutcome<T>): Response {
  return result.ok ? json({ ok: true, ...result.result }) : failure(result.code);
}

export async function topicPinResponse(
  sql: SQL,
  session: Session,
  topicId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body === null || typeof body.pinned !== "boolean") {
    return json({ code: "invalid_request" }, 400);
  }

  return outcome(
    await pin(sql, {
      actorId: session.memberId,
      topicId,
      pinned: body.pinned,
      sessionId: sessionId(session),
    }),
  );
}

export async function topicLockResponse(
  sql: SQL,
  session: Session,
  topicId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body === null || typeof body.locked !== "boolean") {
    return json({ code: "invalid_request" }, 400);
  }

  return outcome(
    await lock(sql, {
      actorId: session.memberId,
      topicId,
      locked: body.locked,
      sessionId: sessionId(session),
    }),
  );
}

export async function topicMoveResponse(
  sql: SQL,
  session: Session,
  topicId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body === null || typeof body.forumId !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  return outcome(
    await move(sql, {
      actorId: session.memberId,
      topicId,
      toForumId: body.forumId,
      ...(typeof body.stubDays === "number" ? { stubDays: body.stubDays } : {}),
      sessionId: sessionId(session),
    }),
  );
}

function stringIds(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
    : [];
}

export async function topicMergeResponse(
  sql: SQL,
  session: Session,
  topicId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);
  const sourceTopicIds = stringIds(body?.sourceTopicIds);

  if (body === null || sourceTopicIds.length === 0) {
    return json({ code: "invalid_request" }, 400);
  }

  return outcome(
    await mergeTopics(sql, {
      actorId: session.memberId,
      destinationTopicId: topicId,
      sourceTopicIds,
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.stubDays === "number" ? { stubDays: body.stubDays } : {}),
      sessionId: sessionId(session),
    }),
  );
}

export async function topicSplitResponse(
  sql: SQL,
  session: Session,
  topicId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);
  const postIds = stringIds(body?.postIds);

  if (body === null || postIds.length === 0) {
    return json({ code: "invalid_request" }, 400);
  }

  const target = body.target;

  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    return json({ code: "invalid_request" }, 400);
  }

  const record = target as Record<string, unknown>;
  let parsedTarget: Parameters<typeof splitTopic>[1]["target"] | null = null;

  if (
    record.kind === "new" &&
    typeof record.forumId === "string" &&
    typeof record.title === "string"
  ) {
    parsedTarget = { kind: "new", forumId: record.forumId, title: record.title };
  } else if (record.kind === "existing" && typeof record.topicId === "string") {
    parsedTarget = { kind: "existing", topicId: record.topicId };
  }

  if (parsedTarget === null) {
    return json({ code: "invalid_request" }, 400);
  }

  return outcome(
    await splitTopic(sql, {
      actorId: session.memberId,
      sourceTopicId: topicId,
      postIds,
      target: parsedTarget,
      sessionId: sessionId(session),
    }),
  );
}

export async function bulkResponse(
  sql: SQL,
  session: Session,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (
    body === null ||
    (body.target !== "topics" && body.target !== "posts") ||
    typeof body.action !== "string"
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  const action = body.action as BulkTopicAction | BulkPostAction;
  const result = await bulkAction(sql, {
    actorId: session.memberId,
    target: body.target,
    action,
    ids: stringIds(body.ids),
    ...(typeof body.forumId === "string" ? { forumId: body.forumId } : {}),
    ...(typeof body.stubDays === "number" ? { stubDays: body.stubDays } : {}),
    sessionId: sessionId(session),
  } satisfies BulkInput);

  return result.ok ? json({ ok: true, applied: result.result.applied }) : failure(result.code);
}

export async function multimodApplyResponse(
  sql: SQL,
  session: Session,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body === null || typeof body.actionId !== "string" || typeof body.topicId !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  return outcome(
    await applyMultimod(sql, {
      actorId: session.memberId,
      actionId: body.actionId,
      topicId: body.topicId,
      sessionId: sessionId(session),
    }),
  );
}
