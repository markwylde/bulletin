import type { AuthService } from "@bulletin/domain/auth";
import {
  deleteDraft,
  readDraft,
  saveDraft,
  validDraftBody,
  validDraftContext,
} from "@bulletin/domain/content";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function contextFrom(url: URL): string | null {
  const value = url.searchParams.get("contextKey");
  return validDraftContext(value) ? value : null;
}

/** `GET /api/me/drafts?contextKey=…` for the opening editor. */
export async function draftGetResponse(sql: SQL, memberId: string, url: URL): Promise<Response> {
  const contextKey = contextFrom(url);

  if (contextKey === null) {
    return json({ code: "invalid_context" }, 400);
  }

  return json({ draft: await readDraft(sql, memberId, contextKey) });
}

/** `PUT /api/me/drafts` with `{ contextKey, bodyMd }`; empty content clears the draft. */
export async function draftSaveResponse(
  sql: SQL,
  memberId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ code: "invalid_request" }, 400);
  }

  const value = body as Record<string, unknown>;

  if (!validDraftContext(value.contextKey) || !validDraftBody(value.bodyMd)) {
    return json({ code: "invalid_draft" }, 400);
  }

  const draft = await saveDraft(sql, memberId, value.contextKey, value.bodyMd);
  return json({ draft });
}

/** `DELETE /api/me/drafts?contextKey=…` clears the context after a successful submit. */
export async function draftDeleteResponse(sql: SQL, memberId: string, url: URL): Promise<Response> {
  const contextKey = contextFrom(url);

  if (contextKey === null) {
    return json({ code: "invalid_context" }, 400);
  }

  await deleteDraft(sql, memberId, contextKey);
  return json({ ok: true });
}

/**
 * `GET|PUT|DELETE /api/me/drafts`. Authentication, Origin and CSRF are enforced by the auth
 * service (ADR 0018); the member id always comes from the session, never from the request.
 */
export async function draftsRoute(
  auth: AuthService,
  sql: SQL,
  request: Request,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/me/drafts") {
    return null;
  }

  const response = await auth.handle(request, async ({ session }) => {
    if (session === null) {
      return json({ code: "unauthenticated" }, 401);
    }

    if (request.method === "GET") {
      return draftGetResponse(sql, session.memberId, new URL(request.url));
    }

    if (request.method === "PUT") {
      return draftSaveResponse(sql, session.memberId, request);
    }

    if (request.method === "DELETE") {
      return draftDeleteResponse(sql, session.memberId, new URL(request.url));
    }

    return json({ code: "method_not_allowed" }, 405);
  });

  return response ?? json({ code: "not_found" }, 404);
}
