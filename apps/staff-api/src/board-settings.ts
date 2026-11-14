import {
  type BoardSettings,
  type BoardSettingsInput,
  parseBoardSettingsInput,
  readBoardSettings,
} from "@bulletin/domain/board";
import { emit } from "@bulletin/domain/events";
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
          id, board_name, board_description, default_locale, offline, offline_message,
          topics_per_page, posts_per_page, public_edit_history, new_member_approval_posts,
          attachment_allowed_types, reactions_affect_reputation, reputation_display,
          reputation_label_scale, api_key_rate_limit_per_minute, api_ip_rate_limit_per_minute
        )
        VALUES (
          1, ${input.boardName}, ${input.boardDescription}, ${input.defaultLocale},
          ${input.offline}, ${input.offlineMessage}, ${input.topicsPerPage},
          ${input.postsPerPage}, ${input.publicEditHistory}, ${input.newMemberApprovalPosts},
          ${`{${input.attachmentAllowedTypes.join(",")}}`}::text[],
          ${input.reactionsAffectReputation}, ${input.reputationDisplay},
          ${JSON.stringify(input.reputationLabelScale)}::jsonb,
          ${input.apiKeyRateLimitPerMinute}, ${input.apiIpRateLimitPerMinute}
        )
        ON CONFLICT (id) DO UPDATE
        SET board_name = EXCLUDED.board_name,
            board_description = EXCLUDED.board_description,
            default_locale = EXCLUDED.default_locale,
            offline = EXCLUDED.offline,
            offline_message = EXCLUDED.offline_message,
            topics_per_page = EXCLUDED.topics_per_page,
            posts_per_page = EXCLUDED.posts_per_page,
            public_edit_history = EXCLUDED.public_edit_history,
            new_member_approval_posts = EXCLUDED.new_member_approval_posts,
            attachment_allowed_types = EXCLUDED.attachment_allowed_types,
            reactions_affect_reputation = EXCLUDED.reactions_affect_reputation,
            reputation_display = EXCLUDED.reputation_display,
            reputation_label_scale = EXCLUDED.reputation_label_scale,
            api_key_rate_limit_per_minute = EXCLUDED.api_key_rate_limit_per_minute,
            api_ip_rate_limit_per_minute = EXCLUDED.api_ip_rate_limit_per_minute
      `;

      const after = await readBoardSettings(tx);

      // Turning the reaction link on or off rebuilds every reaction-sourced entry and total.
      if (before.reactionsAffectReputation !== after.reactionsAffectReputation) {
        await emit(tx, {
          type: "reputation.recount.requested",
          aggregateId: 1n,
          aggregateVersion: 1n,
          payloadIds: { requestedById: BigInt(actorMemberId) },
        });
      }

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
            topicsPerPage: before.topicsPerPage,
            postsPerPage: before.postsPerPage,
            publicEditHistory: before.publicEditHistory,
            newMemberApprovalPosts: before.newMemberApprovalPosts,
            attachmentAllowedTypes: before.attachmentAllowedTypes,
            reactionsAffectReputation: before.reactionsAffectReputation,
            reputationDisplay: before.reputationDisplay,
            reputationLabelScale: before.reputationLabelScale,
            apiKeyRateLimitPerMinute: before.apiKeyRateLimitPerMinute,
            apiIpRateLimitPerMinute: before.apiIpRateLimitPerMinute,
          },
          after: {
            boardName: after.boardName,
            boardDescription: after.boardDescription,
            defaultLocale: after.defaultLocale,
            offline: after.offline,
            offlineMessage: after.offlineMessage,
            topicsPerPage: after.topicsPerPage,
            postsPerPage: after.postsPerPage,
            publicEditHistory: after.publicEditHistory,
            newMemberApprovalPosts: after.newMemberApprovalPosts,
            attachmentAllowedTypes: after.attachmentAllowedTypes,
            reactionsAffectReputation: after.reactionsAffectReputation,
            reputationDisplay: after.reputationDisplay,
            reputationLabelScale: after.reputationLabelScale,
            apiKeyRateLimitPerMinute: after.apiKeyRateLimitPerMinute,
            apiIpRateLimitPerMinute: after.apiIpRateLimitPerMinute,
          },
        },
      });

      return after;
    },
  });

  return { ok: true, settings };
}
