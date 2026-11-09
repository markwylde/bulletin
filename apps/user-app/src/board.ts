import { type BoardSettings, readBoardSettings } from "@bulletin/domain/board";
import { can } from "@bulletin/domain/permissions";
import type { SQL } from "bun";

export type { BoardSettings };

export async function readBoard(sql: SQL): Promise<BoardSettings> {
  return readBoardSettings(sql);
}

/** `board.view_offline` is the only bypass for offline mode. */
export async function canViewOffline(sql: SQL, memberId: string): Promise<boolean> {
  return can(sql, memberId, "board.view_offline");
}
