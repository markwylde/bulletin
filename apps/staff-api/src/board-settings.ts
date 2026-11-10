import {
  type BoardSettings,
  type BoardSettingsInput,
  parseBoardSettingsInput,
  readBoardSettings,
} from "@bulletin/domain/board";
import { boardSettingsMutation, runMutation } from "@bulletin/domain/mutations";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

export type BoardSettingsSaveResult =
  | { readonly ok: true; readonly settings: BoardSettings }
  | { readonly ok: false; readonly fields: readonly string[] };

export async function loadBoardSettings(sql: SQL): Promise<BoardSettings> {
  return readBoardSettings(sql);
}

export async function saveBoardSettings(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<BoardSettingsSaveResult> {
  const parsed = parseBoardSettingsInput(input);

  if (!parsed.ok) {
    return { ok: false, fields: parsed.fields };
  }

  const value: BoardSettingsInput = parsed.value;

  const settings = await runMutation({
    sql,
    mutation: boardSettingsMutation,
    input: value,
    apply: async (tx, input) => {
      await tx`
        INSERT INTO core.board_settings (id, board_name)
        VALUES (1, '')
        ON CONFLICT (id) DO NOTHING
      `;
      await tx`SELECT 1 FROM core.board_settings WHERE id = 1 FOR UPDATE`;
      const before = await readBoardSettings(tx);

      await tx`
        INSERT INTO core.board_settings (
          id, board_name, board_description, default_locale, offline, offline_message
        )
        VALUES (
          1, ${input.boardName}, ${input.boardDescription}, ${input.defaultLocale},
          ${input.offline}, ${input.offlineMessage}
        )
        ON CONFLICT (id) DO UPDATE
        SET board_name = EXCLUDED.board_name,
            board_description = EXCLUDED.board_description,
            default_locale = EXCLUDED.default_locale,
            offline = EXCLUDED.offline,
            offline_message = EXCLUDED.offline_message
      `;

      const after = await readBoardSettings(tx);

      await writeAdminLog(tx, {
        actorMemberId,
        action: "board.settings.update",
        targetType: "board",
        targetId: "1",
        summary: {
          before: {
            boardName: before.boardName,
            boardDescription: before.boardDescription,
            defaultLocale: before.defaultLocale,
            offline: before.offline,
            offlineMessage: before.offlineMessage,
          },
          after: {
            boardName: after.boardName,
            boardDescription: after.boardDescription,
            defaultLocale: after.defaultLocale,
            offline: after.offline,
            offlineMessage: after.offlineMessage,
          },
        },
      });

      return after;
    },
  });

  return { ok: true, settings };
}
