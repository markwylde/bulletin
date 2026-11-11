import type { Mutation } from "./index.ts";

/**
 * Conversation writes are personal content. Conversation responses are `private, no-store`
 * and never enter the shared fragment cache (design, ADR 0006), so these mutations declare no
 * cache tags.
 */
export const conversationStartMutation: Mutation<{ readonly starterId: string }, unknown> = {
  name: "conversation.start",
  tags: () => [],
};

export const conversationReplyMutation: Mutation<
  { readonly conversationId: string; readonly authorId: string },
  unknown
> = {
  name: "conversation.reply",
  tags: () => [],
};

export const conversationParticipantMutation: Mutation<
  { readonly conversationId: string; readonly memberId: string; readonly action: string },
  unknown
> = {
  name: "conversation.participant",
  tags: () => [],
};
