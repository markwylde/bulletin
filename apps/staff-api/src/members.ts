import { removeAvatarForStaff, type StaffAvatarRemoval } from "@bulletin/domain/member";
import { type AvatarVariant, avatarKey, type StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

const VARIANTS: readonly AvatarVariant[] = ["lg", "md", "sm"];

export interface StaffAvatarRemovalInput {
  readonly actorId: string;
  readonly memberId: string;
  readonly blockDays?: number;
}

async function deleteAvatarObjects(
  storage: StorageClient | undefined,
  memberId: string,
  hash: string | null,
): Promise<void> {
  if (storage === undefined || hash === null) {
    return;
  }

  await Promise.all(
    VARIANTS.map((variant) =>
      storage.delete(avatarKey(memberId, hash, variant)).catch(() => undefined),
    ),
  );
}

/** Staff avatar removal (task 5.4): clears, blocks, deletes objects and writes the audit log. */
export async function removeMemberAvatarForStaff(
  sql: SQL,
  storage: StorageClient | undefined,
  input: StaffAvatarRemovalInput,
): Promise<StaffAvatarRemoval> {
  const outcome = await removeAvatarForStaff(sql, input);

  if (!outcome.ok) {
    return outcome;
  }

  await deleteAvatarObjects(storage, input.memberId, outcome.previousHash);
  await writeAdminLog(sql, {
    actorMemberId: input.actorId,
    action: "member.avatar.remove",
    targetType: "member",
    targetId: input.memberId,
    summary: { blockDays: input.blockDays ?? 0 },
  });

  return outcome;
}
