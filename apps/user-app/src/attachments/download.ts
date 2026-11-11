import { isRasterAttachmentType, readDownloadableAttachment } from "@bulletin/domain/attachments";
import {
  can,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import { applyCacheHeaders } from "../http/cache.ts";

/** Presigned GET lifetime for attachments (ADR 0019: revocation is bounded to 60 s). */
export const ATTACHMENT_PRESIGN_EXPIRES_IN = 60;

export interface AttachmentDownloadInput {
  readonly sql: SQL;
  readonly storage: StorageClient;
  /** The valid session, or null for a guest or an invalid/expired cookie. */
  readonly session: { readonly memberId: string; readonly sessionId: string } | null;
  /** True for any session cookie, valid or not: such requests never reach the CDN. */
  readonly hasSessionCookie: boolean;
  readonly id: string;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

/**
 * `Content-Disposition` with an ASCII fallback and RFC 5987 UTF-8 filename. Only allowlisted
 * raster images are inline; everything else is forced into a download (ADR 0019).
 */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const fallback = filename
    .replace(/[^\u0020-\u007e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 255);
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * `GET /attachments/<id>[/<filename>]` (task 3.1). Re-checks `read` + `download` on every
 * referencing forum, then 302s to a 60-second presigned GET on the files origin. The redirect
 * itself is the only CDN-cacheable part, and only for session-less guests who may download it.
 */
export async function attachmentDownloadResponse(
  input: AttachmentDownloadInput,
): Promise<Response> {
  const attachment = await readDownloadableAttachment(input.sql, input.id);

  if (attachment === null) {
    return json({ code: "not_found" }, 404);
  }

  const principal = input.session?.memberId ?? GUEST_PRINCIPAL;
  const tree = await loadForumTree(input.sql);
  const snapshot = await loadPermissionSnapshot(input.sql, principal, {
    tree,
    sessionId: input.session?.sessionId ?? null,
  });
  let allowed = false;

  for (const forumId of attachment.forumIds) {
    const scope = { forumId, tree, snapshot };
    const readable = await can(input.sql, principal, "read", scope);

    if (readable && (await can(input.sql, principal, "download", scope))) {
      allowed = true;
      break;
    }
  }

  if (!allowed) {
    return json({ code: "forbidden" }, 403);
  }

  const inline = isRasterAttachmentType(attachment.contentType);
  const location = input.storage.presignGet(attachment.storageKey, {
    expiresIn: ATTACHMENT_PRESIGN_EXPIRES_IN,
    responseContentType: attachment.contentType,
    responseContentDisposition: contentDisposition(
      inline ? "inline" : "attachment",
      attachment.filename,
    ),
  });
  const headers = new Headers({ location });

  // ADR 0019/0006: only the 302 is cacheable, and only for session-less guests. The presigned
  // URL inside is shorter-lived than the 30 s guest revocation bound, so revocation stays safe.
  applyCacheHeaders(headers, {
    cdnCacheable: true,
    hasSession: input.hasSessionCookie,
    hasUnlockGrant: false,
    tags: [],
    etag: null,
    dev: false,
  });

  return new Response(null, { status: 302, headers });
}
