import { GLOBAL_CACHE_TAGS } from "@bulletin/cache";
import type { EmoticonMutation } from "../content/emoticons.ts";
import type { Mutation } from "./index.ts";

export interface EmoticonMutationInput {
  /** The admin action, for tracing; every successful action invalidates the same set. */
  readonly action: string;
}

/**
 * Emoticon sets are embedded in the editor picker and in shared cached pages. Every successful
 * write bumps one tag so a warm editor cannot keep a removed or renamed emoticon (ADR 0006).
 */
export const emoticonMutation: Mutation<EmoticonMutationInput, EmoticonMutation> = {
  name: "emoticon.mutate",
  tags: (_input, result) => (result.ok ? [GLOBAL_CACHE_TAGS.emoticons] : []),
};
