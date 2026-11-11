import { postTag, topicPagesTag, topicTag } from "@bulletin/cache";
import type { Mutation } from "./index.ts";

export interface AttachmentDeleteSummary {
  readonly postIds: readonly string[];
  readonly topicIds: readonly string[];
}

/**
 * Deleting an attachment changes every post that showed it and every topic page those posts
 * sit on (ADR 0006, 0019). The tags are bumped in the same transaction as the deletion.
 */
export const attachmentDeleteMutation: Mutation<
  { readonly attachmentId: string },
  AttachmentDeleteSummary
> = {
  name: "attachment.delete",
  tags: (_input, result) => [
    ...new Set([
      ...result.postIds.map(postTag),
      ...result.topicIds.flatMap((topicId) => [topicTag(topicId), topicPagesTag(topicId)]),
    ]),
  ],
};
