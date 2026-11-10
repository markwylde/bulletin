import { pollResultsTag, pollTag } from "@bulletin/cache";
import type { Mutation } from "./index.ts";

export interface PollVoteResult {
  readonly pollId: string;
  readonly voterCount: number;
}

/** A vote changes only public counts; hidden results have no counts in shared HTML. */
export const pollVoteMutation: Mutation<{ readonly pollId: string }, PollVoteResult> = {
  name: "poll.vote",
  tags: (_input, result) => [pollResultsTag(result.pollId)],
};

/** Poll text, choices and results visibility live in the shared poll fragment. */
export const pollEditMutation: Mutation<{ readonly pollId: string }, { readonly pollId: string }> =
  {
    name: "poll.edit",
    tags: (_input, result) => [pollTag(result.pollId), pollResultsTag(result.pollId)],
  };
