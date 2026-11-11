import { memberTag } from "@bulletin/cache";
import type { Mutation } from "./index.ts";

export interface MemberAvatarSummary {
  readonly memberId: string;
}

/**
 * An avatar change invalidates the `member:{id}` card fragment only. Post blocks depend on
 * post/topic tags, so they stay cached (ADR 0006, 0019).
 */
export const memberAvatarMutation: Mutation<{ readonly memberId: string }, MemberAvatarSummary> = {
  name: "member.avatar.update",
  tags: (_input, result) => [memberTag(result.memberId)],
};
