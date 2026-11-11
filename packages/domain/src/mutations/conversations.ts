import type { Mutation } from "./index.ts";

/**
 * Starting a conversation writes personal content only. Conversation responses are
 * `private, no-store` and never enter the shared fragment cache (design, ADR 0006), so this
 * mutation declares no cache tags.
 */
export const conversationStartMutation: Mutation<{ readonly starterId: string }, unknown> = {
  name: "conversation.start",
  tags: () => [],
};
