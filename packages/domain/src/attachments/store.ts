import { bumpCacheTags } from "@bulletin/cache";
import {
  type AttachmentRecord,
  type AttachmentRow,
  attachmentFromRow,
  transitionAttachment,
} from "@bulletin/storage";
import type { SQL } from "bun";
import { readBoardSettings } from "../board/settings.ts";
import { attachmentDownloadMutation } from "../mutations/attachments.ts";
import { runMutation } from "../mutations/index.ts";
import { can } from "../permissions/can.ts";
import type { ViewerPrincipal } from "../permissions/principal.ts";
import { loadMergedGroupSettings } from "../permissions/store.ts";
import { loadForumTree } from "../permissions/tree-store.ts";
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
  /** Conversations whose messages reference the attachment; participation is checked. */
  readonly conversationIds: readonly string[];
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
    JOIN core.topics t ON t.id = p.topic_id AND t.visibility = 'visible'
    WHERE pa.attachment_id = ${id}
  `) as Array<{ forum_id: string }>;

  const conversations = (await sql`
    SELECT DISTINCT m.conversation_id::text AS conversation_id
    FROM core.conversation_message_attachments cma
    JOIN core.conversation_messages m ON m.id = cma.message_id
    WHERE cma.attachment_id = ${id}
  `) as Array<{ conversation_id: string }>;

  if (forums.length === 0 && conversations.length === 0) {
    return null;
  }

  return {
    id: row.id,
    storageKey: row.storage_key,
    contentType: row.verified_type,
    filename: row.filename,
    forumIds: forums.map((forum) => forum.forum_id),
    conversationIds: conversations.map((conversation) => conversation.conversation_id),
  };
}

/** True when the member is an active participant in a conversation referencing the file. */
export async function canReadConversationAttachment(
  sql: SQL,
  attachmentId: string,
  memberId: string,
): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM core.conversation_message_attachments cma
    JOIN core.conversation_messages m ON m.id = cma.message_id
    JOIN core.conversation_participants p
      ON p.conversation_id = m.conversation_id
     AND p.member_id = ${memberId}
     AND p.state = 'active'
    WHERE cma.attachment_id = ${attachmentId}
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
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
  /** The member's effective quota; the growth over the snapshot is charged to it. */
  readonly quotaBytes: number;
}

export type PublishResult =
  | { readonly kind: "ready"; readonly attachment: AttachmentRecord }
  | { readonly kind: "quota_exceeded"; readonly attachment: AttachmentRecord }
  | { readonly kind: "skipped" };

/**
 * processing -> ready plus the real-size quota adjustment, in one transaction.
 *
 * Processing can make a file bigger (a PNG that re-encodes to a larger WebP), so publication
 * charges the growth against the member's remaining quota and rejects the upload when it does
 * not fit (ADR 0019). The reservation row is locked, so no concurrent upload can spend the
 * bytes between the check and the move from the snapshot size to the published size.
 */
export async function publishAttachment(
  sql: SQL,
  record: AttachmentRecord,
  input: PublishInput,
): Promise<PublishResult> {
  return sql.begin(async (tx) => {
    await tx`
      INSERT INTO core.member_storage (member_id)
      VALUES (${record.memberId})
      ON CONFLICT (member_id) DO NOTHING
    `;

    const rows = (await tx`
      SELECT used_bytes::text AS used_bytes, reserved_bytes::text AS reserved_bytes
      FROM core.member_storage
      WHERE member_id = ${record.memberId}
      FOR UPDATE
    `) as StorageRow[];
    const row = rows[0];

    if (row === undefined) {
      throw new Error("member_storage row disappeared while locked");
    }

    const increase = input.sizeBytes - (record.sizeBytes ?? 0);
    const remainingBytes = Math.max(
      input.quotaBytes - Number(row.used_bytes) - Number(row.reserved_bytes),
      0,
    );

    if (increase > remainingBytes) {
      const rejected = await transitionAttachment(tx, {
        id: record.id,
        from: "processing",
        to: "rejected",
        rejectionCode: "quota_exceeded",
      });

      if (rejected === null) {
        return { kind: "skipped" };
      }

      await tx`
        UPDATE core.member_storage
        SET used_bytes = GREATEST(used_bytes - ${record.sizeBytes ?? 0}, 0), updated_at = now()
        WHERE member_id = ${record.memberId}
      `;

      return { kind: "quota_exceeded", attachment: rejected };
    }

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
      return { kind: "skipped" };
    }

    if (increase !== 0) {
      await tx`
        UPDATE core.member_storage
        SET used_bytes = GREATEST(used_bytes + ${increase}, 0), updated_at = now()
        WHERE member_id = ${record.memberId}
      `;
    }

    return { kind: "ready", attachment: updated };
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

/**
 * Atomically claims and deletes expired, unreferenced attachments. The row lock and the
 * `NOT EXISTS` recheck make a concurrent post save either keep the row (and its objects) or
 * lose the race cleanly; the caller removes objects only after this transaction commits.
 */
export async function claimExpiredAttachments(
  sql: SQL,
  now: Date = new Date(),
  limit = 200,
): Promise<readonly AttachmentRecord[]> {
  return sql.begin(async (tx) => {
    const candidates = (await tx`
      SELECT a.*
      FROM core.attachments a
      WHERE (
          a.deleted_at <= ${new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000)}
          OR (
            a.expires_at IS NOT NULL
            AND a.expires_at <= ${now}
            AND a.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM core.post_attachments pa WHERE pa.attachment_id = a.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM core.conversation_message_attachments cma
              WHERE cma.attachment_id = a.id
            )
          )
        )
      ORDER BY a.expires_at NULLS LAST, a.id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `) as AttachmentRow[];

    if (candidates.length === 0) {
      return [];
    }

    const ids = candidates.map((row) => row.id);
    const array = `{${ids.join(",")}}`;
    const deleted = (await tx`
      DELETE FROM core.attachments a
      WHERE a.id = ANY(${array}::bigint[])
        AND NOT EXISTS (
          SELECT 1 FROM core.post_attachments pa WHERE pa.attachment_id = a.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM core.conversation_message_attachments cma
          WHERE cma.attachment_id = a.id
        )
      RETURNING a.*
    `) as AttachmentRow[];

    await refreshMemberStorage(
      tx,
      deleted.map((row) => row.member_id),
    );

    return deleted.map(attachmentFromRow);
  });
}

/** Recomputes the derived quota columns from the authoritative attachment rows. */
export async function refreshMemberStorage(sql: SQL, memberIds: readonly string[]): Promise<void> {
  if (memberIds.length === 0) {
    return;
  }

  const ids = [...new Set(memberIds)];
  const array = `{${ids.join(",")}}`;

  await sql`
    INSERT INTO core.member_storage (member_id)
    SELECT unnest(${array}::bigint[])
    ON CONFLICT (member_id) DO NOTHING
  `;

  await sql`
    UPDATE core.member_storage ms
    SET
      -- Finalise moved snapshotted bytes from reserved to used; publication and rejection
      -- adjust only used. Recompute with the same accounting, or a future publication would
      -- leave a stranded reservation.
      used_bytes = COALESCE((
        SELECT sum(a.size_bytes)::bigint
        FROM core.attachments a
        WHERE a.member_id = ms.member_id
          AND a.state IN ('snapshotted', 'processing', 'ready')
          AND a.deleted_at IS NULL
      ), 0),
      reserved_bytes = COALESCE((
        SELECT sum(a.declared_bytes)::bigint
        FROM core.attachments a
        WHERE a.member_id = ms.member_id
          AND a.state = 'pending'
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
  /** The member performing the save: the author, or a moderator editing the post. */
  readonly authorId: string;
  readonly forumId: string;
  readonly sessionId?: string | null;
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

  const tree = await loadForumTree(tx);
  const mayUpload = await can(tx, input.authorId, "upload", {
    forumId: input.forumId,
    tree,
    sessionId: input.sessionId ?? null,
  });
  // A save without upload permission may keep attachments already on the post (a moderator
  // editing it) but never add another one from a forum the member may not upload in.
  const removedArray = `{${removed.join(",") || "0"}}`;
  const owned = (
    mayUpload
      ? await tx`
        SELECT id::text AS id
        FROM core.attachments
        WHERE id = ANY(${`{${ids.join(",")}}`}::bigint[])
          AND state = 'ready'
          AND deleted_at IS NULL
          AND (
            member_id = ${input.authorId}
            OR id = ANY(${removedArray}::bigint[])
          )
      `
      : await tx`
        SELECT id::text AS id
        FROM core.attachments
        WHERE id = ANY(${`{${ids.join(",")}}`}::bigint[])
          AND state = 'ready'
          AND deleted_at IS NULL
          AND id = ANY(${removedArray}::bigint[])
      `
  ) as Array<{ id: string }>;
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

export interface MessageAttachmentRecord {
  readonly id: string;
  readonly messageId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly downloadCount: number;
  readonly inline: boolean;
  readonly position: number;
}

interface MessageAttachmentRow {
  readonly id: string;
  readonly message_id: string;
  readonly filename: string;
  readonly size_bytes: string;
  readonly verified_type: string;
  readonly download_count: string;
  readonly inline: boolean;
  readonly position: number;
}

/** Published attachments linked to each conversation message, in body order. */
export async function readConversationMessageAttachments(
  sql: SQL,
  messageIds: readonly string[],
): Promise<ReadonlyMap<string, readonly MessageAttachmentRecord[]>> {
  const unique = [...new Set(messageIds)];
  const result = new Map<string, MessageAttachmentRecord[]>();

  if (unique.length === 0) {
    return result;
  }

  const rows = (await sql`
    SELECT
      a.id::text AS id,
      cma.message_id::text AS message_id,
      a.filename,
      a.size_bytes::text AS size_bytes,
      a.verified_type,
      a.download_count::text AS download_count,
      cma.inline,
      cma.position
    FROM core.conversation_message_attachments cma
    JOIN core.attachments a ON a.id = cma.attachment_id
    WHERE cma.message_id = ANY(${`{${unique.join(",")}}`}::bigint[])
      AND a.state = 'ready'
      AND a.deleted_at IS NULL
      AND a.verified_type IS NOT NULL
      AND a.size_bytes IS NOT NULL
    ORDER BY cma.message_id, cma.position, a.id
  `) as MessageAttachmentRow[];

  for (const row of rows) {
    const list = result.get(row.message_id) ?? [];
    list.push({
      id: row.id,
      messageId: row.message_id,
      filename: row.filename,
      sizeBytes: Number(row.size_bytes),
      contentType: row.verified_type,
      downloadCount: Number(row.download_count),
      inline: row.inline,
      position: row.position,
    });
    result.set(row.message_id, list);
  }

  return result;
}

export interface SyncConversationMessageAttachmentsInput {
  readonly messageId: string;
  readonly conversationId: string;
  readonly authorId: string;
  readonly bodyHtml: string;
}

/**
 * Links the author's own ready uploads to one conversation message. Participation and message
 * ownership are rechecked inside the transaction; a save without the upload context links
 * nothing, and removing a reference restarts its orphan clock.
 */
export async function syncConversationMessageAttachments(
  tx: SQL,
  input: SyncConversationMessageAttachmentsInput,
): Promise<number> {
  const participant = (await tx`
    SELECT 1
    FROM core.conversation_messages m
    JOIN core.conversation_participants p
      ON p.conversation_id = m.conversation_id
     AND p.member_id = ${input.authorId}
     AND p.state = 'active'
    WHERE m.id = ${input.messageId}
      AND m.conversation_id = ${input.conversationId}
    LIMIT 1
  `) as unknown[];

  if (participant.length === 0) {
    return 0;
  }

  const placeholders = attachmentPlaceholders(input.bodyHtml);
  const ids = [...placeholders.keys()];
  const previous = (await tx`
    DELETE FROM core.conversation_message_attachments
    WHERE message_id = ${input.messageId}
    RETURNING attachment_id::text AS attachment_id
  `) as Array<{ attachment_id: string }>;
  const removed = previous.map((row) => row.attachment_id);

  if (ids.length === 0) {
    if (removed.length > 0) {
      await restartOrphanClock(tx, removed);
    }

    return 0;
  }

  const removedArray = `{${removed.join(",") || "0"}}`;
  const owned = (await tx`
    SELECT id::text AS id
    FROM core.attachments
    WHERE id = ANY(${`{${ids.join(",")}}`}::bigint[])
      AND state = 'ready'
      AND deleted_at IS NULL
      AND (member_id = ${input.authorId} OR id = ANY(${removedArray}::bigint[]))
  `) as Array<{ id: string }>;
  const ownedIds = new Set(owned.map((row) => row.id));
  let position = 0;

  for (const [id, inline] of placeholders) {
    if (!ownedIds.has(id)) {
      continue;
    }

    await tx`
      INSERT INTO core.conversation_message_attachments (message_id, attachment_id, position, inline)
      VALUES (${input.messageId}, ${id}, ${position}, ${inline})
      ON CONFLICT (message_id, attachment_id) DO UPDATE
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

export async function restartOrphanClock(tx: SQL, ids: readonly string[]): Promise<void> {
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

export type RecordDownloadOutcome =
  | { readonly ok: true; readonly downloadCount: number }
  | { readonly ok: false; readonly code: "not_found" | "forbidden" };

/**
 * Counts one authorised download and invalidates the post blocks that show the count. The
 * caller is the user-api beacon endpoint; the content download route itself stays read-only.
 */
export async function recordAttachmentDownload(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly sessionId?: string | null;
    readonly attachmentId: string;
  },
): Promise<RecordDownloadOutcome> {
  const attachment = await readAttachmentById(sql, input.attachmentId);

  if (attachment === null || attachment.state !== "ready" || attachment.sizeBytes === null) {
    return { ok: false, code: "not_found" };
  }

  const references = await readAttachmentReferences(sql, attachment.id);
  const conversationAttachments = (await sql`
    SELECT 1
    FROM core.conversation_message_attachments cma
    WHERE cma.attachment_id = ${attachment.id}
    LIMIT 1
  `) as unknown[];

  if (references.length === 0 && conversationAttachments.length === 0) {
    return { ok: false, code: "not_found" };
  }

  const tree = await loadForumTree(sql);
  let allowed = await canReadConversationAttachment(sql, attachment.id, input.actorId);

  for (const reference of references) {
    if (allowed) {
      break;
    }

    const scope = { forumId: reference.forumId, tree, sessionId: input.sessionId ?? null };
    const readable = await can(sql, input.actorId, "read", scope);

    if (readable && (await can(sql, input.actorId, "download", scope))) {
      allowed = true;
      break;
    }
  }

  if (!allowed) {
    return { ok: false, code: "forbidden" };
  }

  await runMutation({
    sql,
    mutation: attachmentDownloadMutation,
    input: { attachmentId: attachment.id },
    apply: async (tx) => {
      await tx`
        UPDATE core.attachments
        SET download_count = download_count + 1
        WHERE id = ${attachment.id} AND deleted_at IS NULL
      `;
      return {
        postIds: references.map((reference) => reference.postId),
        topicIds: [...new Set(references.map((reference) => reference.topicId))],
      };
    },
  });

  const updated = await readAttachmentById(sql, attachment.id);
  return { ok: true, downloadCount: updated?.downloadCount ?? attachment.downloadCount + 1 };
}

export interface DownloadBufferInput {
  readonly attachmentId: string;
  /** Pseudonymous, rotating viewer digest; never a raw IP (ADR 0012). */
  readonly viewerKey: string;
  readonly now?: Date;
}

/** Records one guest download into the UNLOGGED buffer; the primary key rate-limits per minute. */
export async function recordAttachmentDownloadBuffer(
  sql: SQL,
  input: DownloadBufferInput,
): Promise<void> {
  const now = input.now ?? new Date();
  const bucket = new Date(Math.floor(now.getTime() / 60_000) * 60_000);

  await sql`
    INSERT INTO core.attachment_download_buffer (attachment_id, viewer_key, bucket)
    VALUES (${input.attachmentId}, ${input.viewerKey}, ${bucket})
    ON CONFLICT DO NOTHING
  `;
}

/** Folds guest download counts into the attachment rows and invalidates their posts. */
export async function flushAttachmentDownloadBuffer(sql: SQL): Promise<number> {
  return sql.begin(async (tx) => {
    const counts = (await tx`
      DELETE FROM core.attachment_download_buffer
      RETURNING attachment_id::text AS attachment_id
    `) as Array<{ attachment_id: string }>;

    if (counts.length === 0) {
      return 0;
    }

    const totals = new Map<string, number>();

    for (const row of counts) {
      totals.set(row.attachment_id, (totals.get(row.attachment_id) ?? 0) + 1);
    }

    const postIds = new Set<string>();
    const topicIds = new Set<string>();

    for (const [attachmentId, count] of totals) {
      await tx`
        UPDATE core.attachments
        SET download_count = download_count + ${count}
        WHERE id = ${attachmentId}
      `;

      for (const reference of await readAttachmentReferences(tx, attachmentId)) {
        postIds.add(reference.postId);
        topicIds.add(reference.topicId);
      }
    }

    const tags = attachmentDownloadMutation.tags(
      { attachmentId: "0" },
      { postIds: [...postIds], topicIds: [...topicIds] },
    );

    if (tags.length > 0) {
      await bumpCacheTags(tx, tags);
    }

    return counts.length;
  });
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
  await tx`
    DELETE FROM core.conversation_message_attachments WHERE attachment_id = ${attachmentId}
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
