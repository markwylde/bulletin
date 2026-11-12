import { isLocale, type Locale, resolveRequestLocale } from "@bulletin/i18n";
import type { SQL } from "bun";
import { isBlockedText } from "../filters/repository.ts";
import { NAME_CHANGE_INTERVAL_MS } from "./names.ts";

export interface MemberRecord {
  readonly displayName: string | null;
  readonly locale: Locale | null;
  readonly avatarHash: string | null;
}

export interface NameHistoryEntry {
  readonly oldName: string;
  readonly newName: string;
  readonly changedAt: Date;
  readonly changedBy: string | null;
}

export type UpdateDisplayNameResult =
  | { readonly kind: "ok"; readonly displayName: string }
  | { readonly kind: "missing" }
  | { readonly kind: "taken" }
  | { readonly kind: "limit"; readonly nextAllowedAt: Date }
  | { readonly kind: "blocked_word" }
  | { readonly kind: "banned" };

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { readonly code?: string; readonly errno?: string };
  return (
    candidate.code === "23505" ||
    candidate.errno === "23505" ||
    (error instanceof Error && /duplicate key/i.test(error.message))
  );
}

export async function readMember(sql: SQL, memberId: string): Promise<MemberRecord | null> {
  const [row] = (await sql`
    SELECT display_name, locale, avatar_hash
    FROM core.members
    WHERE id = ${memberId}
  `) as Array<{
    display_name: string | null;
    locale: string | null;
    avatar_hash: string | null;
  }>;

  if (row === undefined) {
    return null;
  }

  return {
    displayName: row.display_name,
    locale: isLocale(row.locale) ? row.locale : null,
    avatarHash: row.avatar_hash,
  };
}

/** Resolves a member's request locale: preference, then board default. */
export async function resolveMemberLocale(sql: SQL, memberId: string): Promise<Locale> {
  const [row] = (await sql`
    SELECT m.locale AS member_locale, b.default_locale AS board_locale
    FROM core.members m
    LEFT JOIN core.board_settings b ON b.id = 1
    WHERE m.id = ${memberId}
  `) as Array<{ member_locale: string | null; board_locale: string | null }>;

  return resolveRequestLocale({
    audience: "member",
    memberLocale: row?.member_locale ?? null,
    boardDefaultLocale: row?.board_locale ?? null,
  }).locale;
}

/**
 * Sets the first display name or changes an existing one. Every change is recorded, and
 * only one change is allowed per constant period until a group setting replaces it.
 */
export async function updateDisplayName(
  sql: SQL,
  memberId: string,
  input: { readonly name: string; readonly skeleton: string },
): Promise<UpdateDisplayNameResult> {
  if (await isBlockedText(sql, input.name)) {
    return { kind: "blocked_word" };
  }

  const banned = (await sql`
    SELECT 1 FROM core.member_groups mg
    JOIN core.groups g ON g.id = mg.group_id
    WHERE mg.member_id = ${memberId} AND g.key = 'banned'
    LIMIT 1
  `) as unknown[];

  if (banned.length > 0) {
    return { kind: "banned" };
  }

  try {
    return await sql.begin(async (tx) => {
      const [member] = (await tx`
        SELECT display_name FROM core.members WHERE id = ${memberId} FOR UPDATE
      `) as Array<{ display_name: string | null }>;

      if (member === undefined) {
        return { kind: "missing" };
      }

      if (member.display_name === input.name) {
        return { kind: "ok", displayName: input.name };
      }

      if (member.display_name !== null) {
        const [last] = (await tx`
          SELECT changed_at FROM core.member_name_history
          WHERE member_id = ${memberId}
          ORDER BY changed_at DESC, id DESC
          LIMIT 1
        `) as Array<{ changed_at: Date | string }>;

        if (last !== undefined) {
          const changedAt = new Date(last.changed_at).getTime();
          const nextAllowedAt = new Date(changedAt + NAME_CHANGE_INTERVAL_MS);

          if (Date.now() < nextAllowedAt.getTime()) {
            return { kind: "limit", nextAllowedAt };
          }
        }
      }

      const [owner] = (await tx`
        SELECT id FROM core.members
        WHERE id <> ${memberId}
          AND (lower(display_name) = lower(${input.name}) OR name_skeleton = ${input.skeleton})
        LIMIT 1
      `) as Array<{ id: string }>;

      if (owner !== undefined) {
        return { kind: "taken" };
      }

      if (member.display_name !== null) {
        await tx`
          INSERT INTO core.member_name_history (member_id, old_name, new_name, changed_by)
          VALUES (${memberId}, ${member.display_name}, ${input.name}, ${memberId})
        `;
      }

      await tx`
        UPDATE core.members
        SET display_name = ${input.name}, name_skeleton = ${input.skeleton}
        WHERE id = ${memberId}
      `;

      return { kind: "ok", displayName: input.name };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { kind: "taken" };
    }

    throw error;
  }
}

export async function readNameHistory(
  sql: SQL,
  memberId: string,
): Promise<readonly NameHistoryEntry[]> {
  const rows = (await sql`
    SELECT old_name, new_name, changed_at, changed_by
    FROM core.member_name_history
    WHERE member_id = ${memberId}
    ORDER BY changed_at DESC, id DESC
  `) as Array<{
    old_name: string;
    new_name: string;
    changed_at: Date | string;
    changed_by: string | null;
  }>;

  return rows.map((row) => ({
    oldName: row.old_name,
    newName: row.new_name,
    changedAt: new Date(row.changed_at),
    changedBy: row.changed_by,
  }));
}

export async function saveMemberLocale(sql: SQL, memberId: string, locale: Locale): Promise<void> {
  await sql`UPDATE core.members SET locale = ${locale} WHERE id = ${memberId}`;
}
