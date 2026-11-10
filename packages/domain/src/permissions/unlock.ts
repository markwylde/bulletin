import type { SQL } from "bun";
import { hasCapabilityBit } from "./actions.ts";
import { loadPermissionSnapshot } from "./snapshot.ts";
import { loadForumTree } from "./tree-store.ts";

export const UNLOCK_FAILURE_LIMIT = 5;
export const UNLOCK_WINDOW_MS = 10 * 60 * 1_000;

export type UnlockForumResult =
  | { readonly kind: "unlocked" }
  | { readonly kind: "wrong_password" }
  | { readonly kind: "throttled"; readonly retryAfterMs: number }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_found" }
  | { readonly kind: "no_password" };

export interface UnlockForumOptions {
  readonly sessionId: string;
  readonly memberId: string;
  readonly forumId: string;
  readonly password: string;
  /** Test seam for throttling windows. */
  readonly now?: Date;
}

interface ForumPasswordRow {
  readonly password_hash: string | null;
}

interface AttemptRow {
  readonly attempted_at: Date;
}

export async function hashForumPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    // A malformed stored hash must fail closed like a wrong password.
    return false;
  }
}

/**
 * Unlocks a password-protected forum for the current session (ADR 0005, 0018).
 *
 * The mask matrix must grant `read`; the password is only the additional session condition.
 * Five failures within ten minutes lock further attempts for ten minutes. The grant is stored
 * in `core.session_grants` and disappears with the session.
 */
export async function unlockForum(
  sql: SQL,
  options: UnlockForumOptions,
): Promise<UnlockForumResult> {
  const now = options.now ?? new Date();

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`bulletin.forum_unlock:${options.sessionId}:${options.forumId}`})::bigint)`;

    const [session] = (await tx`
      SELECT 1
      FROM core.sessions
      WHERE id = ${options.sessionId}
        AND member_id = ${options.memberId}
        AND revoked_at IS NULL
    `) as unknown[];

    if (session === undefined) {
      return { kind: "forbidden" } as const;
    }

    const tree = await loadForumTree(tx);

    if (tree.get(options.forumId) === undefined) {
      return { kind: "not_found" } as const;
    }

    const [forum] = (await tx`
      SELECT password_hash
      FROM core.forums
      WHERE id = ${options.forumId}
    `) as ForumPasswordRow[];

    if (forum === undefined) {
      return { kind: "not_found" } as const;
    }

    if (forum.password_hash === null) {
      return { kind: "no_password" } as const;
    }

    const snapshot = await loadPermissionSnapshot(tx, options.memberId, {
      tree,
      sessionId: options.sessionId,
    });

    // The base `read` bit comes from the masks; the unlock is the extra session condition.
    if (!hasCapabilityBit(snapshot.bits.get(options.forumId) ?? 0, "read")) {
      return { kind: "forbidden" } as const;
    }

    const cutoff = new Date(now.getTime() - UNLOCK_WINDOW_MS);

    // Keep the attempt log bounded; expired failures no longer affect the throttle.
    await tx`
      DELETE FROM core.forum_unlock_attempts
      WHERE session_id = ${options.sessionId}
        AND forum_id = ${options.forumId}
        AND attempted_at <= ${cutoff}
    `;

    const failures = (await tx`
      SELECT attempted_at
      FROM core.forum_unlock_attempts
      WHERE session_id = ${options.sessionId}
        AND forum_id = ${options.forumId}
        AND attempted_at > ${cutoff}
      ORDER BY attempted_at DESC
    `) as AttemptRow[];

    if (failures.length >= UNLOCK_FAILURE_LIMIT) {
      const fifth = failures[UNLOCK_FAILURE_LIMIT - 1];

      if (fifth !== undefined) {
        const retryAt = new Date(fifth.attempted_at).getTime() + UNLOCK_WINDOW_MS;

        if (retryAt > now.getTime()) {
          return { kind: "throttled", retryAfterMs: retryAt - now.getTime() } as const;
        }
      }
    }

    const matched = await verifyPassword(options.password, forum.password_hash);

    await tx`
      INSERT INTO core.forum_unlock_attempts (session_id, forum_id, attempted_at)
      VALUES (${options.sessionId}, ${options.forumId}, ${now})
    `;

    if (!matched) {
      return { kind: "wrong_password" } as const;
    }

    await tx`
      DELETE FROM core.forum_unlock_attempts
      WHERE session_id = ${options.sessionId} AND forum_id = ${options.forumId}
    `;

    await tx`
      INSERT INTO core.session_grants (session_id, kind, resource_id, granted_at)
      VALUES (${options.sessionId}, 'forum_password', ${options.forumId}, ${now})
      ON CONFLICT (session_id, kind, resource_id)
      DO UPDATE SET granted_at = EXCLUDED.granted_at
    `;

    return { kind: "unlocked" } as const;
  });
}
