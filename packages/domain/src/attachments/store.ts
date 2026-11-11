import {
  type AttachmentRecord,
  type AttachmentRow,
  attachmentFromRow,
  transitionAttachment,
} from "@bulletin/storage";
import type { SQL } from "bun";
import { readBoardSettings } from "../board/settings.ts";
import type { ViewerPrincipal } from "../permissions/principal.ts";
import { loadMergedGroupSettings } from "../permissions/store.ts";
import {
  ATTACHMENT_CONTENT_TYPES,
  type AttachmentContentType,
  DOCUMENT_ATTACHMENT_TYPES,
  RASTER_ATTACHMENT_TYPES,
  SVG_ATTACHMENT_TYPE,
  TEXT_ATTACHMENT_TYPES,
} from "./rules.ts";

/** Wake-up channel for a freshly snapshotted upload (ADR 0003: NOTIFY is only a wake-up). */
export const ATTACHMENT_PROCESS_CHANNEL = "bulletin_attachments";

/** Unattached uploads expire 24 hours after the request (ADR 0019). */
export const ATTACHMENT_ORPHAN_AFTER_MS = 24 * 60 * 60 * 1_000;
/** A worker that dies mid-processing is reclaimable after ten minutes. */
export const ATTACHMENT_PROCESSING_STALE_MS = 10 * 60 * 1_000;

export interface UploadLimits {
  /** Total upload bytes the member's groups allow, or 0 when uploads are disabled. */
  readonly quotaBytes: number;
  /** Per-file bytes, or 0 when uploads are disabled. */
  readonly perFileBytes: number;
  /** Board allowlist narrowed by the group's image/document toggles. */
  readonly allowedTypes: readonly AttachmentContentType[];
}

const IMAGE_TYPES = new Set<string>([...RASTER_ATTACHMENT_TYPES, SVG_ATTACHMENT_TYPE]);
const DOCUMENT_TYPES = new Set<string>([...DOCUMENT_ATTACHMENT_TYPES, ...TEXT_ATTACHMENT_TYPES]);

function settingBytes(value: unknown, unit: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value * unit : 0;
}

/** Effective limits from the merged group settings (ADR 0005): `max` merge, 0 = disabled. */
export async function readUploadLimits(
  sql: SQL,
  principal: ViewerPrincipal,
): Promise<UploadLimits> {
  const [merged, board] = await Promise.all([
    loadMergedGroupSettings(sql, principal),
    readBoardSettings(sql),
  ]);
  const images = merged["posting.upload_images"] === true;
  const documents = merged["posting.upload_documents"] === true;
  const boardTypes = new Set(board.attachmentAllowedTypes);
  const allowedTypes = ATTACHMENT_CONTENT_TYPES.filter(
    (type) =>
      boardTypes.has(type) &&
      ((images && IMAGE_TYPES.has(type)) || (documents && DOCUMENT_TYPES.has(type))),
  );

  return {
    quotaBytes: settingBytes(merged["posting.upload_quota_mb"], 1024 * 1024),
    perFileBytes: settingBytes(merged["posting.upload_per_file_kb"], 1024),
    allowedTypes,
  };
}

interface StorageRow {
  readonly used_bytes: string;
  readonly reserved_bytes: string;
}

export interface ReserveUploadInput {
  readonly memberId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly limits: UploadLimits;
}

export type ReserveUploadResult =
  | {
      readonly ok: true;
      readonly attachment: AttachmentRecord;
      readonly remainingBytes: number;
    }
  | {
      readonly ok: false;
      readonly code: "quota_exceeded";
      readonly remainingBytes: number;
      readonly limitBytes: number;
    };

/**
 * Reserves the declared size against the member's quota under a row lock and inserts the
 * `pending` attachment in the same transaction (ADR 0019).
 */
export async function reserveUpload(
  sql: SQL,
  input: ReserveUploadInput,
): Promise<ReserveUploadResult> {
  return sql.begin(async (tx) => {
    await tx`
      INSERT INTO core.member_storage (member_id)
      VALUES (${input.memberId})
      ON CONFLICT (member_id) DO NOTHING
    `;

    const rows = (await tx`
      SELECT used_bytes::text AS used_bytes, reserved_bytes::text AS reserved_bytes
      FROM core.member_storage
      WHERE member_id = ${input.memberId}
      FOR UPDATE
    `) as StorageRow[];
    const row = rows[0];

    if (row === undefined) {
      throw new Error("member_storage row disappeared while locked");
    }

    const remainingBytes = Math.max(
      input.limits.quotaBytes - Number(row.used_bytes) - Number(row.reserved_bytes),
      0,
    );

    if (input.sizeBytes > remainingBytes) {
      return {
        ok: false,
        code: "quota_exceeded",
        remainingBytes,
        limitBytes: input.limits.quotaBytes,
      };
    }

    await tx`
      UPDATE core.member_storage
      SET reserved_bytes = reserved_bytes + ${input.sizeBytes}, updated_at = now()
      WHERE member_id = ${input.memberId}
    `;

    const inserted = (await tx`
      INSERT INTO core.attachments (
        member_id, filename, declared_type, declared_bytes, quarantine_key
      )
      VALUES (
        ${input.memberId},
        ${input.filename},
        ${input.contentType},
        ${input.sizeBytes},
        ${`quarantine/${crypto.randomUUID()}`}
      )
      RETURNING *
    `) as AttachmentRow[];
    const attachment = inserted[0];

    if (attachment === undefined) {
      throw new Error("attachment insert returned no row");
    }

    return {
      ok: true,
      attachment: attachmentFromRow(attachment),
      remainingBytes: remainingBytes - input.sizeBytes,
    };
  });
}

export async function readAttachment(
  sql: SQL,
  memberId: string,
  id: string,
): Promise<AttachmentRecord | null> {
  const rows = (await sql`
    SELECT * FROM core.attachments WHERE id = ${id} AND member_id = ${memberId}
  `) as AttachmentRow[];

  const row = rows[0];
  return row === undefined ? null : attachmentFromRow(row);
}

export async function readAttachmentById(sql: SQL, id: string): Promise<AttachmentRecord | null> {
  const rows = (await sql`SELECT * FROM core.attachments WHERE id = ${id}`) as AttachmentRow[];

  const row = rows[0];
  return row === undefined ? null : attachmentFromRow(row);
}

export interface DownloadableAttachment {
  readonly id: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly filename: string;
  /** Forums whose visible posts reference the attachment; permission is checked on each. */
  readonly forumIds: readonly string[];
}
/**
 * A published attachment plus the forums it appears in. Unreferenced, hidden or rejected
 * attachments are not downloadable; the caller re-checks `can(download)` per request.
 */
export async function readDownloadableAttachment(
  sql: SQL,
  id: string,
): Promise<DownloadableAttachment | null> {
  const rows = (await sql`
    SELECT id, storage_key, verified_type, filename
    FROM core.attachments
    WHERE id = ${id}
      AND state = 'ready'
      AND deleted_at IS NULL
      AND storage_key IS NOT NULL
      AND verified_type IS NOT NULL
  `) as Array<{
    id: string;
    storage_key: string;
    verified_type: string;
    filename: string;
  }>;
  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  const forums = (await sql`
    SELECT DISTINCT t.forum_id::text AS forum_id
    FROM core.post_attachments pa
    JOIN core.posts p ON p.id = pa.post_id AND p.visibility = 'visible'
    JOIN core.topics t ON t.id = p.topic_id
    WHERE pa.attachment_id = ${id}
  `) as Array<{ forum_id: string }>;

  if (forums.length === 0) {
    return null;
  }

  return {
    id: row.id,
    storageKey: row.storage_key,
    contentType: row.verified_type,
    filename: row.filename,
    forumIds: forums.map((forum) => forum.forum_id),
  };
}

export interface RecordSnapshotInput {
  readonly id: string;
  readonly memberId: string;
  readonly snapshotKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * pending -> snapshotted plus the quota move (reserved -> used) in one transaction. A replay
 * returns null because the conditional state transition matched no row.
 */
export async function recordSnapshot(
  sql: SQL,
  input: RecordSnapshotInput,
): Promise<AttachmentRecord | null> {
  return sql.begin(async (tx) => {
    const record = await transitionAttachment(tx, {
      id: input.id,
      from: "pending",
      to: "snapshotted",
      snapshotKey: input.snapshotKey,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
    });

    if (record === null) {
      return null;
    }

    await tx`
      UPDATE core.member_storage
      SET
        reserved_bytes = GREATEST(reserved_bytes - ${record.declaredBytes}, 0),
        used_bytes = used_bytes + ${input.sizeBytes},
        updated_at = now()
      WHERE member_id = ${input.memberId}
    `;

    return record;
  });
}

export interface PublishInput {
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly verifiedType: string;
}

/** processing -> ready plus the real-size quota adjustment, in one transaction. */
export async function publishAttachment(
  sql: SQL,
  record: AttachmentRecord,
  input: PublishInput,
): Promise<AttachmentRecord | null> {
  return sql.begin(async (tx) => {
    const updated = await transitionAttachment(tx, {
      id: record.id,
      from: "processing",
      to: "ready",
      storageKey: input.storageKey,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      verifiedType: input.verifiedType,
    });

    if (updated === null) {
      return null;
    }

    const delta = input.sizeBytes - (record.sizeBytes ?? 0);

    await tx`
      UPDATE core.member_storage
      SET used_bytes = GREATEST(used_bytes + ${delta}, 0), updated_at = now()
      WHERE member_id = ${record.memberId}
    `;

    return updated;
  });
}

/** processing -> rejected, releasing the bytes finalise moved into `used_bytes`. */
export async function rejectAttachment(
  sql: SQL,
  record: AttachmentRecord,
  rejectionCode: string,
): Promise<AttachmentRecord | null> {
  return sql.begin(async (tx) => {
    const updated = await transitionAttachment(tx, {
      id: record.id,
      from: "processing",
      to: "rejected",
      rejectionCode,
    });

    if (updated === null) {
      return null;
    }

    await tx`
      UPDATE core.member_storage
      SET used_bytes = GREATEST(used_bytes - ${record.sizeBytes ?? 0}, 0), updated_at = now()
      WHERE member_id = ${record.memberId}
    `;

    return updated;
  });
}

export interface ProcessableAttachmentsOptions {
  readonly limit?: number;
  /** Rows stuck in `processing` older than this are reclaimed. */
  readonly staleBefore?: Date;
}

/** Work the processing sweep may pick up: fresh snapshots and stale in-flight rows. */
export async function listProcessableAttachments(
  sql: SQL,
  options: ProcessableAttachmentsOptions = {},
): Promise<readonly AttachmentRecord[]> {
  const staleBefore = options.staleBefore ?? new Date(Date.now() - ATTACHMENT_PROCESSING_STALE_MS);
  const rows = (await sql`
    SELECT *
    FROM core.attachments
    WHERE state = 'snapshotted'
       OR (state = 'processing' AND updated_at < ${staleBefore})
    ORDER BY id
    LIMIT ${options.limit ?? 20}
  `) as AttachmentRow[];

  return rows.map(attachmentFromRow);
}

/** Attachments past their 24-hour orphan deadline that no post references. */
export async function listExpiredAttachments(
  sql: SQL,
  now: Date = new Date(),
  limit = 200,
): Promise<readonly AttachmentRecord[]> {
  const rows = (await sql`
    SELECT a.*
    FROM core.attachments a
    WHERE a.deleted_at <= ${new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000)}
       OR (
         a.expires_at IS NOT NULL
         AND a.expires_at <= ${now}
         AND a.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM core.post_attachments pa WHERE pa.attachment_id = a.id
         )
       )
    ORDER BY a.expires_at NULLS LAST, a.id
    LIMIT ${limit}
  `) as AttachmentRow[];

  return rows.map(attachmentFromRow);
}

export interface AttachmentKeysRow {
  readonly state: string;
  readonly quarantine_key: string;
  readonly snapshot_key: string | null;
  readonly storage_key: string | null;
}

export async function listAttachmentKeys(sql: SQL): Promise<readonly AttachmentKeysRow[]> {
  return (await sql`
    SELECT state, quarantine_key, snapshot_key, storage_key FROM core.attachments
  `) as AttachmentKeysRow[];
}

/** Recomputes the derived quota columns from the authoritative attachment rows. */
export async function refreshMemberStorage(sql: SQL, memberIds: readonly string[]): Promise<void> {
  if (memberIds.length === 0) {
    return;
  }

  const ids = [...new Set(memberIds)];
  const array = `{${ids.join(",")}}`;

  await sql`
    UPDATE core.member_storage ms
    SET
      used_bytes = COALESCE((
        SELECT sum(a.size_bytes)::bigint
        FROM core.attachments a
        WHERE a.member_id = ms.member_id AND a.state = 'ready' AND a.deleted_at IS NULL
      ), 0),
      reserved_bytes = COALESCE((
        SELECT sum(a.declared_bytes)::bigint
        FROM core.attachments a
        WHERE a.member_id = ms.member_id
          AND a.state IN ('pending', 'snapshotted', 'processing')
          AND a.deleted_at IS NULL
      ), 0),
      updated_at = now()
    WHERE ms.member_id = ANY(${array}::bigint[])
  `;
}

/** Deletes rows and releases their quota; object deletion happens before this call. */
export async function deleteAttachments(sql: SQL, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }

  const array = `{${ids.join(",")}}`;

  return sql.begin(async (tx) => {
    const rows = (await tx`
      DELETE FROM core.attachments
      WHERE id = ANY(${array}::bigint[])
      RETURNING member_id::text AS member_id
    `) as Array<{ member_id: string }>;

    await refreshMemberStorage(
      tx,
      rows.map((row) => row.member_id),
    );

    return rows.length;
  });
}

export interface PostAttachmentRecord {
  readonly id: string;
  readonly postId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly downloadCount: number;
  readonly inline: boolean;
  readonly position: number;
}

interface PostAttachmentRow {
  readonly id: string;
  readonly post_id: string;
  readonly filename: string;
  readonly size_bytes: string;
  readonly verified_type: string;
  readonly download_count: string;
  readonly inline: boolean;
  readonly position: number;
}

/** Published attachments linked to each post, in body order. */
export async function readPostAttachments(
  sql: SQL,
  postIds: readonly string[],
): Promise<ReadonlyMap<string, readonly PostAttachmentRecord[]>> {
  const unique = [...new Set(postIds)];
  const result = new Map<string, PostAttachmentRecord[]>();

  if (unique.length === 0) {
    return result;
  }

  const rows = (await sql`
    SELECT
      a.id::text AS id,
      pa.post_id::text AS post_id,
      a.filename,
      a.size_bytes::text AS size_bytes,
      a.verified_type,
      a.download_count::text AS download_count,
      pa.inline,
      pa.position
    FROM core.post_attachments pa
    JOIN core.attachments a ON a.id = pa.attachment_id
    WHERE pa.post_id = ANY(${`{${unique.join(",")}}`}::bigint[])
      AND a.state = 'ready'
      AND a.deleted_at IS NULL
      AND a.verified_type IS NOT NULL
      AND a.size_bytes IS NOT NULL
    ORDER BY pa.post_id, pa.position, a.id
  `) as PostAttachmentRow[];

  for (const row of rows) {
    const list = result.get(row.post_id) ?? [];
    list.push({
      id: row.id,
      postId: row.post_id,
      filename: row.filename,
      sizeBytes: Number(row.size_bytes),
      contentType: row.verified_type,
      downloadCount: Number(row.download_count),
      inline: row.inline,
      position: row.position,
    });
    result.set(row.post_id, list);
  }

  return result;
}

const ATTACHMENT_TAG = /<bl-attachment\b([^>]*)>/gi;

function tagAttribute(attributes: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? null;
}

/** Attachment ids in body order, with whether the author placed each one inline. */
export function attachmentPlaceholders(bodyHtml: string): ReadonlyMap<string, boolean> {
  const found = new Map<string, boolean>();

  for (const match of bodyHtml.matchAll(ATTACHMENT_TAG)) {
    const attributes = match[1] ?? "";
    const id = tagAttribute(attributes, "data-id");

    if (id === null || !/^\d+$/.test(id) || found.has(id)) {
      continue;
    }

    found.set(id, tagAttribute(attributes, "data-inline") === "true");
  }

  return found;
}

export interface SyncPostAttachmentsInput {
  readonly postId: string;
  readonly authorId: string;
  readonly bodyHtml: string;
}

/**
 * Synchronises `post_attachments` with the placeholders in the saved body (ADR 0019). Only
 * the author's own ready uploads may be linked; removing a reference restarts the orphan
 * clock when no other post uses the attachment.
 */
export async function syncPostAttachments(
  tx: SQL,
  input: SyncPostAttachmentsInput,
): Promise<number> {
  const placeholders = attachmentPlaceholders(input.bodyHtml);
  const ids = [...placeholders.keys()];
  const previous = (await tx`
    DELETE FROM core.post_attachments
    WHERE post_id = ${input.postId}
    RETURNING attachment_id::text AS attachment_id
  `) as Array<{ attachment_id: string }>;
  const removed = previous.map((row) => row.attachment_id);

  if (ids.length === 0) {
    if (removed.length > 0) {
      await restartOrphanClock(tx, removed);
    }

    return 0;
  }

  const owned = (await tx`
    SELECT id::text AS id
    FROM core.attachments
    WHERE id = ANY(${`{${ids.join(",")}}`}::bigint[])
      AND state = 'ready'
      AND deleted_at IS NULL
      AND (
        member_id = ${input.authorId}
        OR id = ANY(${`{${removed.join(",") || "0"}}`}::bigint[])
      )
  `) as Array<{ id: string }>;
  const ownedIds = new Set(owned.map((row) => row.id));
  let position = 0;

  for (const [id, inline] of placeholders) {
    if (!ownedIds.has(id)) {
      continue;
    }

    await tx`
      INSERT INTO core.post_attachments (post_id, attachment_id, position, inline)
      VALUES (${input.postId}, ${id}, ${position}, ${inline})
      ON CONFLICT (post_id, attachment_id) DO UPDATE
        SET position = EXCLUDED.position, inline = EXCLUDED.inline
    `;
    await tx`
      UPDATE core.attachments
      SET expires_at = NULL, updated_at = now()
      WHERE id = ${id}
    `;
    position += 1;
  }

  const linked = new Set([...ownedIds]);
  const stillRemoved = removed.filter((id) => !linked.has(id));

  if (stillRemoved.length > 0) {
    await restartOrphanClock(tx, stillRemoved);
  }

  return position;
}

async function restartOrphanClock(tx: SQL, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await tx`
    UPDATE core.attachments a
    SET expires_at = now() + interval '24 hours', updated_at = now()
    WHERE a.id = ANY(${`{${ids.join(",")}}`}::bigint[])
      AND NOT EXISTS (
        SELECT 1 FROM core.post_attachments pa WHERE pa.attachment_id = a.id
      )
  `;
}

export interface MemberAttachmentRecord {
  readonly id: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly downloadCount: number;
  readonly createdAt: Date;
}

/** The member's own published attachments, newest first ("My attachments"). */
export async function listMemberAttachments(
  sql: SQL,
  memberId: string,
): Promise<readonly MemberAttachmentRecord[]> {
  const rows = (await sql`
    SELECT
      id::text AS id,
      filename,
      size_bytes::text AS size_bytes,
      verified_type,
      download_count::text AS download_count,
      created_at
    FROM core.attachments
    WHERE member_id = ${memberId}
      AND state = 'ready'
      AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC
  `) as Array<{
    id: string;
    filename: string;
    size_bytes: string;
    verified_type: string;
    download_count: string;
    created_at: Date;
  }>;

  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    contentType: row.verified_type,
    downloadCount: Number(row.download_count),
    createdAt: row.created_at,
  }));
}

export interface StorageUsage {
  readonly usedBytes: number;
  readonly reservedBytes: number;
}

export async function readStorageUsage(sql: SQL, memberId: string): Promise<StorageUsage> {
  const rows = (await sql`
    SELECT used_bytes::text AS used_bytes, reserved_bytes::text AS reserved_bytes
    FROM core.member_storage
    WHERE member_id = ${memberId}
  `) as Array<{ used_bytes: string; reserved_bytes: string }>;
  const row = rows[0];

  return {
    usedBytes: row === undefined ? 0 : Number(row.used_bytes),
    reservedBytes: row === undefined ? 0 : Number(row.reserved_bytes),
  };
}

export interface AttachmentReference {
  readonly postId: string;
  readonly topicId: string;
  readonly forumId: string;
}

export async function readAttachmentReferences(
  sql: SQL,
  attachmentId: string,
): Promise<readonly AttachmentReference[]> {
  const rows = (await sql`
    SELECT
      p.id::text AS post_id,
      t.id::text AS topic_id,
      t.forum_id::text AS forum_id
    FROM core.post_attachments pa
    JOIN core.posts p ON p.id = pa.post_id
    JOIN core.topics t ON t.id = p.topic_id
    WHERE pa.attachment_id = ${attachmentId}
    ORDER BY p.id
  `) as Array<{ readonly post_id: string; readonly topic_id: string; readonly forum_id: string }>;

  return rows.map((row) => ({
    postId: row.post_id,
    topicId: row.topic_id,
    forumId: row.forum_id,
  }));
}

/** Soft-deletes one member's attachment and releases its quota. */
export async function softDeleteAttachment(
  tx: SQL,
  attachmentId: string,
  memberId: string,
): Promise<void> {
  await tx`
    UPDATE core.attachments
    SET deleted_at = now(), updated_at = now()
    WHERE id = ${attachmentId} AND member_id = ${memberId} AND deleted_at IS NULL
  `;
  await tx`
    DELETE FROM core.post_attachments WHERE attachment_id = ${attachmentId}
  `;
  await refreshMemberStorage(tx, [memberId]);
}

/** Removes an attachment from one post; the attachment stays usable elsewhere. */
export async function unlinkAttachmentFromPost(
  tx: SQL,
  postId: string,
  attachmentId: string,
): Promise<void> {
  await tx`
    DELETE FROM core.post_attachments
    WHERE post_id = ${postId} AND attachment_id = ${attachmentId}
  `;
  await restartOrphanClock(tx, [attachmentId]);
}
