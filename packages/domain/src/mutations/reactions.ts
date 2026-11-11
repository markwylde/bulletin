import { GLOBAL_CACHE_TAGS, memberTag, postReactionsTag } from "@bulletin/cache";
import type { Mutation } from "./index.ts";

export interface ReactionSetResult {
  readonly postId: string;
  /** The author whose reputation changed, when the reaction link is on. */
  readonly reputationReceiverId: string | null;
}

/** A member's reaction changes only that post's reaction bar, never its body (ADR 0006). */
export const reactionSetMutation: Mutation<{ readonly postId: string }, ReactionSetResult> = {
  name: "reaction.set",
  tags: (_input, result) => [
    postReactionsTag(result.postId),
    ...(result.reputationReceiverId === null
      ? []
      : [memberTag(result.reputationReceiverId), GLOBAL_CACHE_TAGS.directory]),
  ],
};

export interface ReactionAdminResult {
  /** Null when a create collided with an existing key (reported as `duplicate_key`). */
  readonly reactionId: string | null;
}

/** The staff-managed set is shared by every reaction bar on the board. */
export const reactionAdminMutation: Mutation<{ readonly action: string }, ReactionAdminResult> = {
  name: "reaction.admin",
  tags: () => [GLOBAL_CACHE_TAGS.reactions],
};
