import type { SaveContentOptions } from "@bulletin/content";
import { loadContentRenderDependencies } from "@bulletin/domain/content";
import type { SQL } from "bun";
import { staffFlagValue } from "./features.ts";

export type StaffContentRenderOptions = Pick<
  SaveContentOptions,
  "emoticons" | "mentions" | "embeds" | "unfurls"
>;

/**
 * The current rendering inputs for staff-authored content (ADR 0007). Without them, known
 * emoticon codes, `@name` mentions and provider URLs would be stored as plain text and stay
 * marked as current until a later version upgrade. Mention and unfurl rendering honour the
 * author's flags (ADR 0010); emoticons and embeds are core.
 */
export async function loadStaffContentRenderOptions(
  sql: SQL,
  authorId: string,
): Promise<StaffContentRenderOptions> {
  const [dependencies, mentions, unfurls] = await Promise.all([
    loadContentRenderDependencies(sql),
    staffFlagValue(sql, authorId, "mentions"),
    staffFlagValue(sql, authorId, "unfurls"),
  ]);

  return {
    emoticons: dependencies.emoticons,
    embeds: dependencies.embeds,
    ...(mentions ? { mentions: dependencies.mentions } : {}),
    ...(unfurls ? { unfurls: true } : {}),
  };
}
