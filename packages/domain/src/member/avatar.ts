import type { SQL } from "bun";
import { runMutation } from "../mutations/index.ts";
import { memberAvatarMutation } from "../mutations/members.ts";
import { can } from "../permissions/can.ts";
import { loadMergedGroupSettings } from "../permissions/store.ts";

export interface AvatarPolicy {
  /** Upload bytes allowed by the group setting; 0 means avatars are disabled. */
  readonly maxBytes: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly blockedUntil: Date | null;
}

export interface MemberAvatar {
  readonly hash: string | null;
  readonly blockedUntil: Date | null;
}

async function readAvatarRow(sql: SQL, memberId: string): Promise<MemberAvatar | null> {
  const rows = (await sql`
    SELECT avatar_hash, avatar_blocked_until
    FROM core.members
    WHERE id = ${memberId}
  `) as Array<{ avatar_hash: string | null; avatar_blocked_until: Date | null }>;
  const row = rows[0];

  return row === undefined
    ? null
    : { hash: row.avatar_hash, blockedUntil: row.avatar_blocked_until };
}

export async function readMemberAvatar(sql: SQL, memberId: string): Promise<MemberAvatar | null> {
  return readAvatarRow(sql, memberId);
}

async function scheduleAvatarDeletion(
  tx: SQL,
  memberId: string,
  hash: string | null,
): Promise<void> {
  if (hash === null) {
    return;
  }

  await tx`
    INSERT INTO core.avatar_deletions (member_id, avatar_hash)
    VALUES (${memberId}, ${hash})
    ON CONFLICT (member_id, avatar_hash) DO NOTHING
  `;
}

export interface PendingAvatarDeletion {
  readonly memberId: string;
  readonly avatarHash: string;
  readonly attempts: number;
  readonly createdAt: Date;
}

export async function listAvatarDeletions(
  sql: SQL,
  limit = 50,
): Promise<readonly PendingAvatarDeletion[]> {
  const rows = (await sql`
    SELECT member_id::text AS member_id, avatar_hash, attempts, created_at
    FROM core.avatar_deletions
    ORDER BY created_at, member_id
    LIMIT ${limit}
  `) as Array<{
    member_id: string;
    avatar_hash: string;
    attempts: number;
    created_at: Date;
  }>;

  return rows.map((row) => ({
    memberId: row.member_id,
    avatarHash: row.avatar_hash,
    attempts: row.attempts,
    createdAt: row.created_at,
  }));
}

export async function finishAvatarDeletion(
  sql: SQL,
  memberId: string,
  hash: string,
): Promise<void> {
  await sql`
    DELETE FROM core.avatar_deletions
    WHERE member_id = ${memberId} AND avatar_hash = ${hash}
  `;
}

export async function markAvatarDeletionFailed(
  sql: SQL,
  memberId: string,
  hash: string,
): Promise<void> {
  await sql`
    UPDATE core.avatar_deletions
    SET attempts = attempts + 1
    WHERE member_id = ${memberId} AND avatar_hash = ${hash}
  `;
}

/** The merged `members.avatar_max_kb` limit (max across groups) plus any staff block. */
export async function readAvatarPolicy(sql: SQL, memberId: string): Promise<AvatarPolicy | null> {
  const avatar = await readAvatarRow(sql, memberId);

  if (avatar === null) {
    return null;
  }

  const settings = await loadMergedGroupSettings(sql, memberId);
  const maxKb = settings["members.avatar_max_kb"];
  const maxWidth = settings["members.avatar_max_width"];
  const maxHeight = settings["members.avatar_max_height"];

  return {
    maxBytes: typeof maxKb === "number" && maxKb > 0 ? maxKb * 1024 : 0,
    maxWidth: typeof maxWidth === "number" && maxWidth > 0 ? maxWidth : 512,
    maxHeight: typeof maxHeight === "number" && maxHeight > 0 ? maxHeight : 512,
    blockedUntil: avatar.blockedUntil,
  };
}

export type SetMemberAvatarResult = "ok" | "blocked" | "missing";

/**
 * Stores the content hash and invalidates the member card, not the post blocks. The block is
 * rechecked in the UPDATE itself so an upload that passed its early policy check cannot land
 * after staff removed the avatar and applied a block.
 */
export async function setMemberAvatar(
  sql: SQL,
  memberId: string,
  hash: string,
): Promise<SetMemberAvatarResult> {
  let result: SetMemberAvatarResult = "missing";

  await runMutation({
    sql,
    mutation: memberAvatarMutation,
    input: { memberId },
    apply: async (tx) => {
      const [current] = (await tx`
        SELECT avatar_hash, avatar_blocked_until
        FROM core.members
        WHERE id = ${memberId}
        FOR UPDATE
      `) as Array<{ avatar_hash: string | null; avatar_blocked_until: Date | null }>;

      if (current === undefined) {
        result = "missing";
        return { memberId };
      }

      if (
        current.avatar_blocked_until !== null &&
        current.avatar_blocked_until.getTime() > Date.now()
      ) {
        result = "blocked";
        return { memberId };
      }

      if (current.avatar_hash !== hash) {
        await scheduleAvatarDeletion(tx, memberId, current.avatar_hash);
      }

      await tx`
        UPDATE core.members
        SET avatar_hash = ${hash}, avatar_updated_at = now()
        WHERE id = ${memberId}
      `;
      // Re-uploading the same hash cancels any pending deletion of those objects.
      await tx`
        DELETE FROM core.avatar_deletions
        WHERE member_id = ${memberId} AND avatar_hash = ${hash}
      `;
      result = "ok";
      return { memberId };
    },
  });

  return result;
}

export interface ClearAvatarOptions {
  /** Set by staff removal; omitted for a member removing their own avatar. */
  readonly blockUntil?: Date | null;
}

/** Clears the avatar and returns the previous hash so callers can remove its objects. */
export async function clearMemberAvatar(
  sql: SQL,
  memberId: string,
  options: ClearAvatarOptions = {},
): Promise<string | null> {
  let previousHash: string | null = null;

  await runMutation({
    sql,
    mutation: memberAvatarMutation,
    input: { memberId },
    apply: async (tx) => {
      const [previous] = (await tx`
        SELECT avatar_hash FROM core.members WHERE id = ${memberId} FOR UPDATE
      `) as Array<{ avatar_hash: string | null }>;

      if (previous === undefined) {
        return { memberId };
      }

      previousHash = previous.avatar_hash;
      await scheduleAvatarDeletion(tx, memberId, previous.avatar_hash);

      if (options.blockUntil === undefined) {
        await tx`
          UPDATE core.members
          SET avatar_hash = NULL, avatar_updated_at = now()
          WHERE id = ${memberId}
        `;
      } else {
        await tx`
          UPDATE core.members
          SET avatar_hash = NULL, avatar_updated_at = now(), avatar_blocked_until = ${options.blockUntil}
          WHERE id = ${memberId}
        `;
      }

      return { memberId };
    },
  });

  return previousHash;
}

export interface StaffAvatarRemovalInput {
  readonly actorId: string;
  readonly memberId: string;
  /** Number of days the member may not set a new avatar; 0 means no block. */
  readonly blockDays?: number;
}

export type StaffAvatarRemoval =
  | {
      readonly ok: true;
      readonly previousHash: string | null;
      readonly blockedUntil: Date | null;
    }
  | { readonly ok: false; readonly code: "forbidden" | "not_found" };

/**
 * Staff removal (task 5.4): requires `members.edit`, clears the avatar, optionally blocks new
 * uploads and returns what the caller needs to delete objects and write the audit log.
 */
export async function removeAvatarForStaff(
  sql: SQL,
  input: StaffAvatarRemovalInput,
): Promise<StaffAvatarRemoval> {
  if (!(await can(sql, input.actorId, "members.edit"))) {
    return { ok: false, code: "forbidden" };
  }

  const avatar = await readAvatarRow(sql, input.memberId);

  if (avatar === null) {
    return { ok: false, code: "not_found" };
  }

  const blockDays = Math.min(Math.max(Math.trunc(input.blockDays ?? 0), 0), 3_650);
  const blockedUntil =
    blockDays === 0 ? null : new Date(Date.now() + blockDays * 24 * 60 * 60 * 1_000);
  const previousHash = await clearMemberAvatar(sql, input.memberId, { blockUntil: blockedUntil });

  return { ok: true, previousHash, blockedUntil };
}
