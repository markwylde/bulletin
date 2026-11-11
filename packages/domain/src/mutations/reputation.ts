import { memberTag } from "@bulletin/cache";
import type { Mutation } from "./index.ts";

export interface ReputationGiveResult {
  readonly receiverId: string;
}

/**
 * A reputation change rebuilds only the receiver's `member:{id}:card`; the post blocks that
 * embed the card stay cached (ADR 0006).
 */
export const reputationGiveMutation: Mutation<
  { readonly receiverId: string },
  ReputationGiveResult
> = {
  name: "reputation.give",
  tags: (_input, result) => [memberTag(result.receiverId)],
};
