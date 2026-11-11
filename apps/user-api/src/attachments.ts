import {
  ATTACHMENT_PROCESS_CHANNEL,
  deleteAttachment,
  parseUploadRequest,
  readAttachment,
  readUploadLimits,
  recordAttachmentDownload,
  recordSnapshot,
  reserveUpload,
  sha256Hex,
} from "@bulletin/domain/attachments";
import { readParticipation } from "@bulletin/domain/conversations";
import {
  can,
  loadForumTree,
  loadPermissionSnapshot,
  type PermissionSnapshot,
} from "@bulletin/domain/permissions";
import {
  type AttachmentRecord,
  PRESIGN_PUT_EXPIRES_IN,
  processingKey,
  type StorageClient,
} from "@bulletin/storage";
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

/** Public shape of an attachment; the bucket key is never exposed. */
function attachmentView(record: AttachmentRecord) {
  return {
    id: record.id,
    state: record.state,
    filename: record.filename,
    sizeBytes: record.sizeBytes ?? record.declaredBytes,
    contentType: record.verifiedType,
    downloadCount: record.downloadCount,
  };
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

/**
 * `POST /api/attachments` (task 2.1): checks upload permission, per-file size, type allowlist
 * and quota, reserves the declared bytes and returns a five-minute presigned PUT with an exact
 * content-length condition (ADR 0019).
 */
export async function attachmentRequestResponse(
  sql: SQL,
  storage: StorageClient,
  session: Session,
  request: Request,
): Promise<Response> {
  const parsed = parseUploadRequest(await bodyRecord(request));

  if (!parsed.ok) {
    return json({ code: parsed.code }, parsed.code === "type_not_allowed" ? 415 : 400);
  }

  const { forumId, conversationId, filename, contentType, sizeBytes } = parsed.value;

  if (forumId !== undefined) {
    const permissions = await permissionSnapshot(sql, session);
    const allowed = await can(sql, session.memberId, "upload", {
      forumId,
      tree: permissions.tree,
      snapshot: permissions.snapshot,
    });

    if (!allowed) {
      return json({ code: "forbidden" }, 403);
    }
  } else if (
    conversationId === undefined ||
    (await readParticipation(sql, conversationId, session.memberId)) === null
  ) {
    // The conversation upload context checks current participation, not forum `upload`.
    return json({ code: "forbidden" }, 403);
  }

  const limits = await readUploadLimits(sql, session.memberId);

  if (!limits.allowedTypes.includes(contentType)) {
    return json({ code: "type_not_allowed" }, 415);
  }

  if (limits.perFileBytes === 0 || sizeBytes > limits.perFileBytes) {
    return json({ code: "file_too_large", maxBytes: limits.perFileBytes }, 413);
  }

  const reserved = await reserveUpload(sql, {
    memberId: session.memberId,
    filename,
    contentType,
    sizeBytes,
    limits,
  });

  if (!reserved.ok) {
    return json(
      {
        code: reserved.code,
        remainingBytes: reserved.remainingBytes,
        limitBytes: reserved.limitBytes,
      },
      413,
    );
  }

  const uploadUrl = storage.presignPut(reserved.attachment.quarantineKey, {
    contentLength: sizeBytes,
  });

  return json(
    {
      ...attachmentView(reserved.attachment),
      remainingBytes: reserved.remainingBytes,
      upload: {
        url: uploadUrl,
        method: "PUT",
        expiresIn: PRESIGN_PUT_EXPIRES_IN,
        contentLength: sizeBytes,
      },
    },
    201,
  );
}

/**
 * `POST /api/attachments/<id>/finalise` (task 2.2): copies the quarantine object to an
 * immutable snapshot, records its checksum and releases quarantine. Idempotent: repeating it
 * returns the current state, and the replayed presigned PUT can no longer affect the result.
 */
export async function attachmentFinaliseResponse(
  sql: SQL,
  storage: StorageClient,
  session: Session,
  id: string,
): Promise<Response> {
  const record = await readAttachment(sql, session.memberId, id);

  if (record === null) {
    return json({ code: "not_found" }, 404);
  }

  if (record.state === "rejected") {
    return json({ code: "attachment_rejected", rejectionCode: record.rejectionCode }, 409);
  }

  if (record.state !== "pending") {
    return json(attachmentView(record));
  }

  if (!(await storage.exists(record.quarantineKey))) {
    return json({ code: "upload_missing" }, 409);
  }

  const snapshotKey = processingKey(crypto.randomUUID());

  try {
    await storage.copy(record.quarantineKey, snapshotKey);
  } catch {
    return json({ code: "upload_missing" }, 409);
  }

  const bytes = await storage.get(snapshotKey);

  if (bytes.byteLength === 0) {
    await storage.delete(snapshotKey).catch(() => undefined);
    return json({ code: "upload_empty" }, 400);
  }

  if (bytes.byteLength !== record.declaredBytes) {
    await storage.delete(snapshotKey).catch(() => undefined);
    return json({ code: "size_mismatch" }, 409);
  }

  const updated = await recordSnapshot(sql, {
    id: record.id,
    memberId: session.memberId,
    snapshotKey,
    sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
  });

  if (updated === null) {
    // Another finalise won the race; this snapshot is a stray the reconciler removes.
    await storage.delete(snapshotKey).catch(() => undefined);
    const latest = await readAttachment(sql, session.memberId, id);

    return latest === null ? json({ code: "not_found" }, 404) : json(attachmentView(latest));
  }

  await storage.delete(record.quarantineKey).catch(() => undefined);
  // Wake the processing worker; the state row is the durable source of truth.
  await sql.notify(ATTACHMENT_PROCESS_CHANNEL, updated.id).catch(() => undefined);

  return json(attachmentView(updated));
}

/**
 * `POST /api/attachments/<id>/delete` (tasks 4.3, 4.4). Owners delete their file everywhere;
 * a moderator with `edit` passes `postId` to remove it from that post only.
 */
export async function attachmentDeleteResponse(
  sql: SQL,
  session: Session,
  id: string,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);
  const rawPostId = body?.postId;
  const postId = typeof rawPostId === "string" && /^\d+$/.test(rawPostId) ? rawPostId : undefined;

  if (rawPostId !== undefined && postId === undefined) {
    return json({ code: "invalid_request" }, 400);
  }

  const outcome = await deleteAttachment(sql, {
    actorId: session.memberId,
    sessionId: session.id ?? session.sessionId ?? null,
    attachmentId: id,
    ...(postId === undefined ? {} : { postId }),
  });

  if (!outcome.ok) {
    return json({ code: outcome.code }, outcome.code === "forbidden" ? 403 : 404);
  }

  return json({ ok: true });
}

/** `POST /api/attachments/<id>/download`: counts one authorised download (task finding 9). */
export async function attachmentDownloadCountResponse(
  sql: SQL,
  session: Session,
  id: string,
): Promise<Response> {
  const outcome = await recordAttachmentDownload(sql, {
    actorId: session.memberId,
    sessionId: session.id ?? session.sessionId ?? null,
    attachmentId: id,
  });

  if (!outcome.ok) {
    return json({ code: outcome.code }, outcome.code === "forbidden" ? 403 : 404);
  }

  return json({ downloadCount: outcome.downloadCount });
}

/** The production route wrapper, so tests exercise the flag guard and the handler together. */
export interface AttachmentRouteFlags {
  guard(
    key: string,
    memberId: string,
  ): (request: Request, next: () => Response | Promise<Response>) => Promise<Response>;
}

export function attachmentRequestRoute(
  sql: SQL,
  storage: StorageClient,
  flags: AttachmentRouteFlags,
  session: Session,
  request: Request,
): Promise<Response> {
  return flags.guard("attachments", session.memberId)(request, () =>
    attachmentRequestResponse(sql, storage, session, request),
  );
}

export function attachmentFinaliseRoute(
  sql: SQL,
  storage: StorageClient,
  flags: AttachmentRouteFlags,
  session: Session,
  id: string,
): Promise<Response> {
  return flags.guard("attachments", session.memberId)(
    new Request("http://bulletin.localhost/"),
    () => attachmentFinaliseResponse(sql, storage, session, id),
  );
}

export function attachmentDeleteRoute(
  sql: SQL,
  flags: AttachmentRouteFlags,
  session: Session,
  id: string,
  request: Request,
): Promise<Response> {
  return flags.guard("attachments", session.memberId)(request, () =>
    attachmentDeleteResponse(sql, session, id, request),
  );
}

export function attachmentDownloadCountRoute(
  sql: SQL,
  flags: AttachmentRouteFlags,
  session: Session,
  id: string,
): Promise<Response> {
  return flags.guard("attachments", session.memberId)(
    new Request("http://bulletin.localhost/"),
    () => attachmentDownloadCountResponse(sql, session, id),
  );
}
