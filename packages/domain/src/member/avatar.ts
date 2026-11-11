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
      const rows = (await tx`
        UPDATE core.members
        SET avatar_hash = ${hash}, avatar_updated_at = now()
        WHERE id = ${memberId}
          AND (avatar_blocked_until IS NULL OR avatar_blocked_until <= now())
        RETURNING id
      `) as Array<{ id: string }>;

      if (rows.length > 0) {
        result = "ok";
      } else {
        const [member] = (await tx`
          SELECT 1 FROM core.members WHERE id = ${memberId}
        `) as unknown[];
        result = member === undefined ? "missing" : "blocked";
      }

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
  const previous = await readAvatarRow(sql, memberId);

  if (previous === null) {
    return null;
  }

  await runMutation({
    sql,
    mutation: memberAvatarMutation,
    input: { memberId },
    apply: async (tx) => {
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

  return previous.hash;
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
