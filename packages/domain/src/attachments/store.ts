import {
  type AttachmentRecord,
  type AttachmentRow,
  attachmentFromRow,
  transitionAttachment,
} from "@bulletin/storage";
import type { SQL } from "bun";
import type { ViewerPrincipal } from "../permissions/principal.ts";
import { loadMergedGroupSettings } from "../permissions/store.ts";

/** Unattached uploads expire 24 hours after the request (ADR 0019). */
export const ATTACHMENT_ORPHAN_AFTER_MS = 24 * 60 * 60 * 1_000;
/** A worker that dies mid-processing is reclaimable after ten minutes. */
export const ATTACHMENT_PROCESSING_STALE_MS = 10 * 60 * 1_000;

export interface UploadLimits {
  /** Total upload bytes the member's groups allow, or 0 when uploads are disabled. */
  readonly quotaBytes: number;
  /** Per-file bytes, or 0 when uploads are disabled. */
  readonly perFileBytes: number;
}

function settingBytes(value: unknown, unit: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value * unit : 0;
}

/** Effective limits from the merged group settings (ADR 0005): `max` merge, 0 = disabled. */
export async function readUploadLimits(
  sql: SQL,
  principal: ViewerPrincipal,
): Promise<UploadLimits> {
  const merged = await loadMergedGroupSettings(sql, principal);

  return {
    quotaBytes: settingBytes(merged["posting.upload_quota_mb"], 1024 * 1024),
    perFileBytes: settingBytes(merged["posting.upload_per_file_kb"], 1024),
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
    WHERE a.expires_at IS NOT NULL
      AND a.expires_at <= ${now}
      AND a.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM core.post_attachments pa WHERE pa.attachment_id = a.id
      )
    ORDER BY a.expires_at, a.id
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
        WHERE a.member_id = ms.member_id AND a.state = 'ready'
      ), 0),
      reserved_bytes = COALESCE((
        SELECT sum(a.declared_bytes)::bigint
        FROM core.attachments a
        WHERE a.member_id = ms.member_id
          AND a.state IN ('pending', 'snapshotted', 'processing')
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
