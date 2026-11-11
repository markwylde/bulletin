import { evaluatePromotion } from "@bulletin/db/jobs";
import { can, GUEST_PRINCIPAL, loadForumTree } from "@bulletin/domain/permissions";
import {
  type ReactionErrorCode,
  readReaction,
  readReactionTarget,
  readReactors,
  setReaction,
} from "@bulletin/domain/reactions";
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

function failure(code: ReactionErrorCode): Response {
  const status =
    code === "not_found" ? 404 : code === "forbidden" || code === "own_post" ? 403 : 400;

  return json({ code }, status);
}

/**
 * `POST /api/posts/<id>/reactions` (reactions spec): `{reactionId}` adds or changes the
 * member's reaction and `{reactionId: null}` removes it. Every write is per-request: the
 * shared bar is cached, the member's own state arrives through the overlay (ADR 0006).
 */
export async function reactionSetResponse(
  sql: SQL,
  session: Session,
  postId: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);
  const raw = body?.reactionId;
  const reactionId =
    raw === null ? null : typeof raw === "string" && /^\d+$/.test(raw) ? raw : undefined;

  if (reactionId === undefined) {
    return json({ code: "invalid_reaction" }, 400);
  }

  const result = await setReaction(sql, {
    actorId: session.memberId,
    postId,
    reactionId,
    sessionId: session.id ?? session.sessionId ?? null,
  });

  if (!result.ok) {
    return failure(result.code);
  }

  if (result.result.reputationReceiverId !== null) {
    await evaluatePromotion(sql, result.result.reputationReceiverId).catch(() => undefined);
  }

  return json({
    ok: true,
    postId: result.result.postId,
    mine: result.result.mine,
    summary: result.result.summary,
  });
}

/**
 * `GET /api/posts/<id>/reactions?reactionId=<id>` (reactions spec "Who reacted"). Anyone who
 * can read the post may see the list; it never includes anything but a display name.
 */
export async function reactionMembersResponse(
  sql: SQL,
  session: Session | null,
  postId: string,
  url: URL,
): Promise<Response> {
  const reactionId = url.searchParams.get("reactionId") ?? "";

  if (!/^\d+$/.test(reactionId)) {
    return json({ code: "invalid_reaction" }, 400);
  }

  const target = await readReactionTarget(sql, postId);

  if (target === null) {
    return json({ code: "not_found" }, 404);
  }

  const principal = session?.memberId ?? GUEST_PRINCIPAL;
  const tree = await loadForumTree(sql);
  const scope = {
    forumId: target.forumId,
    tree,
    sessionId: session?.id ?? session?.sessionId ?? null,
  };
  const readable = await can(sql, principal, "read", scope);

  // A held or deleted post stays invisible to viewers without the matching moderator bit,
  // even when they know the post id (ADR 0005).
  const visible =
    target.visibility === "visible" ||
    (target.visibility === "unapproved" && (await can(sql, principal, "see_unapproved", scope))) ||
    (target.visibility === "soft_deleted" && (await can(sql, principal, "see_deleted", scope)));

  if (!readable || !visible) {
    return json({ code: "not_found" }, 404);
  }

  const reaction = await readReaction(sql, reactionId);

  if (reaction === null) {
    return json({ code: "invalid_reaction" }, 400);
  }

  const members = await readReactors(sql, target.postId, reaction.id);

  return json({
    members: members.map((member) => ({
      id: member.id,
      name: member.displayName,
    })),
  });
}
