import { evaluatePromotion } from "@bulletin/db/jobs";
import { readBoardSettings } from "@bulletin/domain/board";
import {
  can,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
  type PermissionSnapshot,
} from "@bulletin/domain/permissions";
import { parsePollInput } from "@bulletin/domain/polls";
import {
  editPost,
  hardDelete,
  postFloodWait,
  readPostContext,
  readPostHistory,
  readTopic,
  readTopicPageOfPost,
  recordPostFlood,
  reply,
  restore,
  softDelete,
  startTopic,
  type TopicMutationCode,
  viewerCanReadPostHistory,
} from "@bulletin/domain/topics";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

interface Session {
  readonly memberId: string;
  /** The auth record's `id`; tests pass `sessionId` directly. */
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

function failure(code: TopicMutationCode, retryAfterSeconds?: number): Response {
  const status =
    code === "forbidden" || code === "edit_window_expired"
      ? 403
      : code === "topic_not_found" || code === "post_not_found" || code === "forum_not_found"
        ? 404
        : code === "locked" || code === "first_post_requires_topic_delete"
          ? 409
          : 400;

  return json({ code, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) }, status);
}

/** Serialises the flood check and the accepted write for one member across processes. */
async function withPostFloodLock<T>(
  sql: SQL,
  memberId: string,
  run: (locked: SQL) => Promise<T>,
): Promise<T> {
  const reserved = await sql.reserve();
  const key = `bulletin.post_flood:${memberId}`;

  try {
    await reserved`SELECT pg_advisory_lock(hashtext(${key}))`;
    return await run(reserved);
  } finally {
    try {
      await reserved`SELECT pg_advisory_unlock(hashtext(${key}))`;
    } finally {
      await reserved.release();
    }
  }
}

async function permissionSnapshot(
  sql: SQL,
  session: Session,
): Promise<{ tree: Awaited<ReturnType<typeof loadForumTree>>; snapshot: PermissionSnapshot }> {
  const tree = await loadForumTree(sql);
  const snapshot = await loadPermissionSnapshot(sql, session.memberId, {
    tree,
    sessionId: session.id ?? session.sessionId ?? null,
  });

  return { tree, snapshot };
}

async function postUrl(
  sql: SQL,
  session: Session,
  topicId: string,
  postId: string,
): Promise<string | null> {
  const [topic, settings, permissions] = await Promise.all([
    readTopic(sql, topicId),
    readBoardSettings(sql),
    permissionSnapshot(sql, session),
  ]);

  if (topic === null) {
    return null;
  }

  const seeUnapproved = await can(sql, permissions.snapshot.memberId, "see_unapproved", {
    forumId: topic.forumId,
    tree: permissions.tree,
    snapshot: permissions.snapshot,
  });
  const seeDeleted = await can(sql, permissions.snapshot.memberId, "see_deleted", {
    forumId: topic.forumId,
    tree: permissions.tree,
    snapshot: permissions.snapshot,
  });
  const position = await readTopicPageOfPost(sql, {
    topicId,
    postId,
    perPage: settings.postsPerPage,
    seeUnapproved,
    seeDeleted,
  });

  if (position === null) {
    return canonicalUrl("topic", topic.id, topic.slug);
  }

  return `${canonicalUrl("topic", topic.id, topic.slug, { page: position.page })}#post-${postId}`;
}

/** `POST /api/forums/<id>/topics` (task 3.1). */
export async function createTopicResponse(
  sql: SQL,
  session: Session,
  forumId: string,
  request: Request,
  options: { readonly pollsEnabled?: boolean } = {},
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body === null) {
    return json({ code: "invalid_request" }, 400);
  }

  if (body.poll !== undefined && body.poll !== null && options.pollsEnabled === false) {
    return json({ code: "not_found" }, 404);
  }

  const poll =
    body.poll === undefined || body.poll === null ? undefined : parsePollInput(body.poll);

  if (body.poll !== undefined && body.poll !== null && poll === null) {
    return json({ code: "invalid_poll" }, 400);
  }

  const result = await withPostFloodLock(sql, session.memberId, async (locked) => {
    const wait = await postFloodWait(locked, session.memberId);

    if (wait > 0) {
      return json({ code: "flood_control", retryAfterSeconds: wait }, 429);
    }

    const created = await startTopic(locked, {
      actorId: session.memberId,
      forumId,
      title: typeof body.title === "string" ? body.title : "",
      bodyMd: typeof body.bodyMd === "string" ? body.bodyMd : "",
      ...(typeof body.prefixId === "string" ? { prefixId: body.prefixId } : {}),
      ...(poll === null || poll === undefined ? {} : { poll }),
    });

    if (!created.ok) {
      return failure(created.code);
    }

    await recordPostFlood(locked, session.memberId);
    return created.result;
  });

  if (result instanceof Response) {
    return result;
  }

  await evaluatePromotion(sql, session.memberId).catch(() => undefined);
  const topic = await readTopic(sql, result.topicId);

  return json({
    ok: true,
    topicId: result.topicId,
    postId: result.postId,
    url:
      topic === null
        ? canonicalUrl("topic", result.topicId, "")
        : canonicalUrl("topic", topic.id, topic.slug),
  });
}

/** `POST /api/topics/<id>/replies` (task 3.1). */
export async function replyResponse(
  sql: SQL,
  session: Session,
  topicId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body === null || typeof body.bodyMd !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  const bodyMd = body.bodyMd;

  const result = await withPostFloodLock(sql, session.memberId, async (locked) => {
    const wait = await postFloodWait(locked, session.memberId);

    if (wait > 0) {
      return json({ code: "flood_control", retryAfterSeconds: wait }, 429);
    }

    const created = await reply(locked, {
      actorId: session.memberId,
      topicId,
      sessionId: session.id ?? session.sessionId ?? null,
      bodyMd,
    });

    if (!created.ok) {
      return failure(created.code);
    }

    await recordPostFlood(locked, session.memberId);
    return created.result;
  });

  if (result instanceof Response) {
    return result;
  }

  await evaluatePromotion(sql, session.memberId).catch(() => undefined);

  return json({
    ok: true,
    topicId: result.topicId,
    postId: result.postId,
    url: await postUrl(sql, session, result.topicId, result.postId),
  });
}

/** `POST /api/posts/<id>/edit` (tasks 3.3, 3.4). */
export async function editPostResponse(
  sql: SQL,
  session: Session,
  postId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body === null || typeof body.bodyMd !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  const result = await editPost(sql, {
    actorId: session.memberId,
    postId,
    sessionId: session.id ?? session.sessionId ?? null,
    bodyMd: body.bodyMd,
    ...(typeof body.redact === "boolean" ? { redact: body.redact } : {}),
  });

  if (!result.ok) {
    return failure(result.code);
  }

  return json({ ok: true, ...result.result });
}

/** `GET /api/posts/<id>/history` (task 3.3). */
export async function postHistoryResponse(
  sql: SQL,
  session: Session | null,
  postId: string,
): Promise<Response> {
  const post = await readPostContext(sql, postId);

  if (post === null) {
    return json({ code: "post_not_found" }, 404);
  }

  const settings = await readBoardSettings(sql);
  const tree = await loadForumTree(sql);
  const principal = session === null ? GUEST_PRINCIPAL : session.memberId;
  const sessionId = session === null ? null : (session.id ?? session.sessionId ?? null);
  const snapshot = await loadPermissionSnapshot(sql, principal, { tree, sessionId });

  if (session === null && !settings.publicEditHistory) {
    return json({ code: "unauthenticated" }, 401);
  }

  const permissionScope = { forumId: post.forumId, tree, sessionId, snapshot };

  if (!(await can(sql, principal, "read", permissionScope))) {
    return json({ code: "forbidden" }, 403);
  }

  if (
    post.visibility === "soft_deleted" &&
    !(await can(sql, principal, "see_deleted", permissionScope))
  ) {
    return json({ code: "forbidden" }, 403);
  }

  if (
    post.visibility === "unapproved" &&
    (session === null || post.authorId !== session.memberId) &&
    !(await can(sql, principal, "see_unapproved", permissionScope))
  ) {
    return json({ code: "forbidden" }, 403);
  }

  const viewerId = session?.memberId ?? null;
  const allowed = await viewerCanReadPostHistory(sql, {
    viewerId,
    forumId: post.forumId,
    tree,
    publicHistory: settings.publicEditHistory,
  });

  if (!allowed) {
    return json({ code: "forbidden" }, 403);
  }

  const revisions = await readPostHistory(sql, {
    postId,
    viewerId,
    forumId: post.forumId,
    tree,
    publicHistory: settings.publicEditHistory,
  });

  return json({
    post: {
      id: post.id,
      bodyMd: post.bodyMd,
      createdAt: post.createdAt.toISOString(),
      editedAt: post.editedAt?.toISOString() ?? null,
      editedByName: post.editedByName,
      visibility: post.visibility,
    },
    revisions: revisions.map((revision) => ({
      id: revision.id,
      bodyMd: revision.bodyMd,
      editorName: revision.editorName,
      editedAt: revision.editedAt.toISOString(),
      protected: revision.protected,
    })),
  });
}

/** `POST /api/posts/<id>/delete` with `{action: "soft"|"restore"|"hard"}` (task 3.5). */
export async function postDeleteResponse(
  sql: SQL,
  session: Session,
  postId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);
  const action = body?.action;

  if (action === "soft") {
    const result = await softDelete(sql, {
      actorId: session.memberId,
      postId,
      sessionId: session.id ?? session.sessionId ?? null,
    });
    return result.ok ? json({ ok: true }) : failure(result.code);
  }

  if (action === "restore") {
    const result = await restore(sql, {
      actorId: session.memberId,
      postId,
      sessionId: session.id ?? session.sessionId ?? null,
    });
    return result.ok ? json({ ok: true }) : failure(result.code);
  }

  if (action === "hard") {
    const result = await hardDelete(sql, {
      actorId: session.memberId,
      postId,
      sessionId: session.id ?? session.sessionId ?? null,
    });
    return result.ok ? json({ ok: true }) : failure(result.code);
  }

  return json({ code: "invalid_action" }, 400);
}

/** `POST /api/topics/<id>/delete` with `{action: "hard"}` (task 3.5). */
export async function topicDeleteResponse(
  sql: SQL,
  session: Session,
  topicId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);

  if (body?.action !== "hard") {
    return json({ code: "invalid_action" }, 400);
  }

  const result = await hardDelete(sql, {
    actorId: session.memberId,
    topicId,
    sessionId: session.id ?? session.sessionId ?? null,
  });
  return result.ok ? json({ ok: true }) : failure(result.code);
}
