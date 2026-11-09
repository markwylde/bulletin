import type { SessionRecord } from "@bulletin/domain/auth";
import { readBoardSettings } from "@bulletin/domain/board";
import { can } from "@bulletin/domain/permissions";
import type { SQL } from "bun";

export interface BoardView {
  readonly boardName: string;
  readonly boardDescription: string;
  readonly defaultLocale: "en" | "es" | "fr";
  readonly offline: boolean;
  readonly offlineMessage: string;
  readonly canViewOffline: boolean;
}

/** The public board state used by the static user-app shell. */
export async function boardView(sql: SQL, session: SessionRecord | null): Promise<BoardView> {
  const board = await readBoardSettings(sql);
  const canViewOffline =
    session !== null && (await can(sql, session.memberId, "board.view_offline"));

  return { ...board, canViewOffline };
}
