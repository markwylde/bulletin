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
