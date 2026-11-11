import type { SQL } from "bun";

/**
 * Attachment lifecycle (ADR 0019):
 *
 *   pending -> snapshotted -> processing -> ready | rejected
 *
 * Every transition is one conditional `UPDATE … WHERE state = $previous`, so finalise and
 * the processing worker are idempotent: a replayed step matches no row and returns null.
 */

export const ATTACHMENT_STATES = [
  "pending",
  "snapshotted",
  "processing",
  "ready",
  "rejected",
] as const;
export type AttachmentState = (typeof ATTACHMENT_STATES)[number];

const TRANSITIONS: Readonly<Record<AttachmentState, readonly AttachmentState[]>> = {
  pending: ["snapshotted"],
  snapshotted: ["processing"],
  processing: ["ready", "rejected"],
  ready: [],
  rejected: [],
};

export interface AttachmentRecord {
  readonly id: string;
  readonly memberId: string;
  readonly state: AttachmentState;
  readonly filename: string;
  readonly declaredType: string;
  readonly declaredBytes: number;
  readonly quarantineKey: string;
  readonly snapshotKey: string | null;
  readonly storageKey: string | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly verifiedType: string | null;
  readonly rejectionCode: string | null;
  readonly downloadCount: number;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TransitionAttachmentInput {
  readonly id: string;
  readonly from: AttachmentState;
  readonly to: AttachmentState;
  /** Required for `snapshotted`: the immutable `processing/<uuid>` copy. */
  readonly snapshotKey?: string;
  /** Required for `snapshotted` and `ready`: the object's byte size. */
  readonly sizeBytes?: number;
  /** Required for `snapshotted` and `ready`: SHA-256 of the bytes at that stage. */
  readonly sha256?: string;
  /** Required for `ready`: the final `att/<uuid>` object. */
  readonly storageKey?: string;
  /** Required for `ready`: the type sniffed from the bytes, never the declared type. */
  readonly verifiedType?: string;
  /** Required for `rejected`: a stable, non-user-facing reason code. */
  readonly rejectionCode?: string;
}

export interface AttachmentRow {
  readonly id: string;
  readonly member_id: string;
  readonly state: AttachmentState;
  readonly filename: string;
  readonly declared_type: string;
  readonly declared_bytes: number;
  readonly quarantine_key: string;
  readonly snapshot_key: string | null;
  readonly storage_key: string | null;
  readonly size_bytes: number | null;
  readonly sha256: string | null;
  readonly verified_type: string | null;
  readonly rejection_code: string | null;
  readonly download_count: number;
  readonly expires_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether the state machine allows moving from `from` to `to`. */
export function canTransition(from: AttachmentState, to: AttachmentState): boolean {
  return TRANSITIONS[from].includes(to);
}

function requireFields(input: TransitionAttachmentInput): void {
  if (!canTransition(input.from, input.to)) {
    throw new Error(`Attachment cannot move from ${input.from} to ${input.to}`);
  }

  if (input.to === "snapshotted") {
    if (input.snapshotKey === undefined) {
      throw new Error("Snapshotting an attachment requires a snapshot key");
    }

    if (input.sizeBytes === undefined || input.sizeBytes <= 0) {
      throw new Error("Snapshotting an attachment requires a positive size");
    }

    if (input.sha256 === undefined || !SHA256_HEX.test(input.sha256)) {
      throw new Error("Snapshotting an attachment requires a lowercase SHA-256");
    }
  }

  if (input.to === "ready") {
    if (input.storageKey === undefined) {
      throw new Error("Publishing an attachment requires a storage key");
    }

    if (input.sizeBytes === undefined || input.sizeBytes <= 0) {
      throw new Error("Publishing an attachment requires a positive size");
    }

    if (input.sha256 === undefined || !SHA256_HEX.test(input.sha256)) {
      throw new Error("Publishing an attachment requires a lowercase SHA-256");
    }

    if (input.verifiedType === undefined) {
      throw new Error("Publishing an attachment requires a verified type");
    }
  }

  if (input.to === "rejected" && input.rejectionCode === undefined) {
    throw new Error("Rejecting an attachment requires a reason code");
  }
}

export function attachmentFromRow(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    state: row.state,
    filename: row.filename,
    declaredType: row.declared_type,
    declaredBytes: Number(row.declared_bytes),
    quarantineKey: row.quarantine_key,
    snapshotKey: row.snapshot_key,
    storageKey: row.storage_key,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    sha256: row.sha256,
    verifiedType: row.verified_type,
    rejectionCode: row.rejection_code,
    downloadCount: Number(row.download_count),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Applies one transition under `WHERE state = from`. Returns the updated row, or null when
 * another attempt already moved it (the caller treats that as an idempotent no-op).
 */
export async function transitionAttachment(
  sql: SQL,
  input: TransitionAttachmentInput,
): Promise<AttachmentRecord | null> {
  requireFields(input);

  const rows = (await sql`
    UPDATE core.attachments
    SET
      state = ${input.to},
      snapshot_key = COALESCE(${input.snapshotKey ?? null}, snapshot_key),
      storage_key = COALESCE(${input.storageKey ?? null}, storage_key),
      size_bytes = COALESCE(${input.sizeBytes ?? null}, size_bytes),
      sha256 = COALESCE(${input.sha256 ?? null}, sha256),
      verified_type = COALESCE(${input.verifiedType ?? null}, verified_type),
      rejection_code = COALESCE(${input.rejectionCode ?? null}, rejection_code),
      updated_at = now()
    WHERE id = ${input.id}
      AND state = ${input.from}
    RETURNING *
  `) as AttachmentRow[];

  const row = rows[0];
  return row === undefined ? null : attachmentFromRow(row);
}
