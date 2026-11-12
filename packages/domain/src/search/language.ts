import type { SQL } from "bun";

/** The Postgres text-search configurations Bulletin supports (ADR 0017). */
export type SearchConfig = "english" | "spanish" | "french" | "simple";

/** Maps a board locale to the matching text-search config; anything else stays unstemmed. */
export function textSearchConfig(locale: string | null | undefined): SearchConfig {
  switch (locale === null || locale === undefined ? "" : locale.split("-")[0]?.toLowerCase()) {
    case "es":
      return "spanish";
    case "fr":
      return "french";
    case "en":
      return "english";
    default:
      return "simple";
  }
}

/** Workers listen on this channel to rebuild one forum's language after a settings change. */
export const FORUM_LANGUAGE_CHANNEL = "search_forum_language";

/**
 * Wakes the worker after the forum's `search_lang_version` was bumped. NOTIFY is a wake-up
 * only: the worker re-reads the durable versions from `core.forums` (ADR 0003, 0011).
 */
export async function notifyForumLanguageChange(tx: SQL, forumId: string): Promise<void> {
  await tx`SELECT pg_notify(${FORUM_LANGUAGE_CHANNEL}, ${forumId})`;
}
