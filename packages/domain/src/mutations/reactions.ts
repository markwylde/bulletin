import { GLOBAL_CACHE_TAGS, postReactionsTag } from "@bulletin/cache";
import type { Mutation } from "./index.ts";

export interface ReactionSetResult {
  readonly postId: string;
}

/** A member's reaction changes only that post's reaction bar, never its body (ADR 0006). */
export const reactionSetMutation: Mutation<{ readonly postId: string }, ReactionSetResult> = {
  name: "reaction.set",
  tags: (_input, result) => [postReactionsTag(result.postId)],
};

export interface ReactionAdminResult {
  readonly reactionId: string;
}

/** The staff-managed set is shared by every reaction bar on the board. */
export const reactionAdminMutation: Mutation<{ readonly action: string }, ReactionAdminResult> = {
  name: "reaction.admin",
  tags: () => [GLOBAL_CACHE_TAGS.reactions],
};
