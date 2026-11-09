import { DEFAULT_LOCALE, isLocale, type Locale } from "@bulletin/i18n";
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
