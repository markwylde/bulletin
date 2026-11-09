import { DEFAULT_LOCALE, isLocale, type Locale, resolveRequestLocale } from "@bulletin/i18n";
import type { SQL } from "bun";

/** Reads the board default locale, falling back to English if the row or value is missing. */
export async function readBoardDefaultLocale(sql: SQL): Promise<Locale> {
  const rows = (await sql`
    SELECT default_locale
    FROM core.board_settings
    WHERE id = 1
  `) as Array<{ default_locale: string }>;

  const value = rows[0]?.default_locale;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Reads a member's saved locale preference, or null when they have not chosen one. */
export async function readMemberLocale(sql: SQL, memberId: string): Promise<Locale | null> {
  const rows = (await sql`
    SELECT locale
    FROM core.members
    WHERE id = ${memberId}
  `) as Array<{ locale: string | null }>;

  const value = rows[0]?.locale;
  return isLocale(value) ? value : null;
}

/**
 * Resolves the locale for a logged-in member's requests: their saved preference, then the
 * board default. It reads the database, so a preference follows the member across devices.
 */
export async function resolveMemberLocale(sql: SQL, memberId: string): Promise<Locale> {
  const [memberLocale, boardDefaultLocale] = await Promise.all([
    readMemberLocale(sql, memberId),
    readBoardDefaultLocale(sql),
  ]);

  return resolveRequestLocale({
    audience: "member",
    memberLocale,
    boardDefaultLocale,
  }).locale;
}
