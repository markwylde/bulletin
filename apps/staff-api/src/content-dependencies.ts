import type { SaveContentOptions } from "@bulletin/content";
import { loadContentRenderDependencies } from "@bulletin/domain/content";
import type { SQL } from "bun";
import { staffFlagValue } from "./features.ts";

export type StaffContentRenderOptions = Pick<
  SaveContentOptions,
  "emoticons" | "mentions" | "embeds"
>;

/**
 * The current rendering inputs for staff-authored content (ADR 0007). Without them, known
 * emoticon codes, `@name` mentions and provider URLs would be stored as plain text and stay
 * marked as current until a later version upgrade. Mention rendering honours the author's
 * `mentions` flag (ADR 0010); emoticons and embeds are core.
 *
 * Rules and announcements deliberately never produce unfurl cards: those belong to member
 * posts (`topics-posts`), so a standalone URL stays an ordinary link for staff content.
 */
export async function loadStaffContentRenderOptions(
  sql: SQL,
  authorId: string,
): Promise<StaffContentRenderOptions> {
  const [dependencies, mentions] = await Promise.all([
    loadContentRenderDependencies(sql),
    staffFlagValue(sql, authorId, "mentions"),
  ]);

  return {
    emoticons: dependencies.emoticons,
    embeds: dependencies.embeds,
    ...(mentions ? { mentions: dependencies.mentions } : {}),
  };
}
