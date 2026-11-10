import { DEFAULT_LOCALE, isLocale, type Locale } from "@bulletin/i18n";
import type { SQL } from "bun";

export interface BoardSettings {
  readonly boardName: string;
  readonly boardDescription: string;
  readonly defaultLocale: Locale;
  readonly offline: boolean;
  readonly offlineMessage: string;
  readonly topicsPerPage: number;
  readonly postsPerPage: number;
  readonly publicEditHistory: boolean;
}

export interface BoardSettingsInput {
  readonly boardName: string;
  readonly boardDescription: string;
  readonly defaultLocale: Locale;
  readonly offline: boolean;
  readonly offlineMessage: string;
  readonly topicsPerPage: number;
  readonly postsPerPage: number;
  readonly publicEditHistory: boolean;
}

export const EMPTY_BOARD_SETTINGS: BoardSettings = {
  boardName: "",
  boardDescription: "",
  defaultLocale: DEFAULT_LOCALE,
  offline: false,
  offlineMessage: "",
  topicsPerPage: 20,
  postsPerPage: 20,
  publicEditHistory: false,
};

export async function readBoardSettings(sql: SQL): Promise<BoardSettings> {
  const rows = (await sql`
    SELECT board_name, board_description, default_locale, offline, offline_message,
      topics_per_page, posts_per_page, public_edit_history
    FROM core.board_settings
    WHERE id = 1
  `) as Array<{
    board_name: string;
    board_description: string;
    default_locale: string;
    offline: boolean;
    offline_message: string;
    topics_per_page: number;
    posts_per_page: number;
    public_edit_history: boolean;
  }>;
  const row = rows[0];

  return {
    boardName: row?.board_name ?? "",
    boardDescription: row?.board_description ?? "",
    defaultLocale: isLocale(row?.default_locale) ? row.default_locale : DEFAULT_LOCALE,
    offline: row?.offline ?? false,
    offlineMessage: row?.offline_message ?? "",
    topicsPerPage: row?.topics_per_page ?? 20,
    postsPerPage: row?.posts_per_page ?? 20,
    publicEditHistory: row?.public_edit_history ?? false,
  };
}

export type BoardSettingsParseResult =
  | { readonly ok: true; readonly value: BoardSettingsInput }
  | { readonly ok: false; readonly fields: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pageSize(value: unknown): number | null {
  if (value === undefined) {
    return 20;
  }

  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : null;
}

/** Validates a staff board-settings request body. Field ids match the form definition. */
export function parseBoardSettingsInput(value: unknown): BoardSettingsParseResult {
  if (!isRecord(value)) {
    return { ok: false, fields: ["form"] };
  }

  const fields: string[] = [];
  const boardName = typeof value.boardName === "string" ? value.boardName.trim() : "";
  const boardDescription = typeof value.boardDescription === "string" ? value.boardDescription : "";
  const offline = value.offline === true;
  const offlineMessage = typeof value.offlineMessage === "string" ? value.offlineMessage : "";
  const rawLocale = typeof value.defaultLocale === "string" ? value.defaultLocale : null;
  const defaultLocale: Locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  if (boardName.length === 0 || boardName.length > 100) {
    fields.push("boardName");
  }

  if (boardDescription.length > 5_000) {
    fields.push("boardDescription");
  }

  if (offline && offlineMessage.trim().length === 0) {
    fields.push("offlineMessage");
  }

  if (offlineMessage.length > 5_000) {
    fields.push("offlineMessage");
  }

  const topicsPerPage = pageSize(value.topicsPerPage);
  const postsPerPage = pageSize(value.postsPerPage);
  const publicEditHistory = value.publicEditHistory === true;

  if (topicsPerPage === null) {
    fields.push("topicsPerPage");
  }

  if (postsPerPage === null) {
    fields.push("postsPerPage");
  }

  if (value.defaultLocale !== undefined && !isLocale(String(value.defaultLocale))) {
    fields.push("defaultLocale");
  }

  if (fields.length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    value: {
      boardName,
      boardDescription,
      defaultLocale,
      offline,
      offlineMessage,
      topicsPerPage: topicsPerPage ?? 20,
      postsPerPage: postsPerPage ?? 20,
      publicEditHistory,
    },
  };
}
