import { GLOBAL_CACHE_TAGS } from "@bulletin/cache";
import type { BoardSettings, BoardSettingsInput } from "../board/index.ts";
import type { Mutation } from "./index.ts";

/**
 * A board settings save changes the shared home shell (name, description, locale, offline
 * state), so it invalidates `board` in the same transaction as the row (ADR 0006).
 */
export const boardSettingsMutation: Mutation<BoardSettingsInput, BoardSettings> = {
  name: "board.settings.update",
  tags: () => [GLOBAL_CACHE_TAGS.board],
};

/** The hourly leaderboard recompute invalidates every cached leaderboard page. */
export const leaderboardMutation: Mutation<Record<string, never>, unknown> = {
  name: "leaderboard.recompute",
  tags: () => [GLOBAL_CACHE_TAGS.leaderboards],
};
