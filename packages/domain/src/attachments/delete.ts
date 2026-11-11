import type { SQL } from "bun";
import { attachmentDeleteMutation } from "../mutations/attachments.ts";
import { runMutation } from "../mutations/index.ts";
import { can, loadForumTree } from "../permissions/index.ts";
import {
  readAttachmentById,
  readAttachmentReferences,
  softDeleteAttachment,
  unlinkAttachmentFromPost,
} from "./store.ts";

export interface DeleteAttachmentInput {
  readonly actorId: string;
  readonly sessionId?: string | null;
  readonly attachmentId: string;
  /** The post a moderator is removing the attachment from. Owners delete globally. */
  readonly postId?: string;
}

export type DeleteAttachmentOutcome =
  | { readonly ok: true; readonly postIds: readonly string[]; readonly topicIds: readonly string[] }
  | { readonly ok: false; readonly code: "not_found" | "forbidden" };

/**
 * Owner deletion removes the attachment everywhere (soft delete with a restore window).
 * A moderator with `edit` power may remove it from one post without deleting the member's
 * file, and both paths invalidate the referencing post/topic fragments (task 4.4).
 */
export async function deleteAttachment(
  sql: SQL,
  input: DeleteAttachmentInput,
): Promise<DeleteAttachmentOutcome> {
  const attachment = await readAttachmentById(sql, input.attachmentId);

  if (attachment === null || attachment.state !== "ready" || attachment.sizeBytes === null) {
    return { ok: false, code: "not_found" };
  }

  const references = await readAttachmentReferences(sql, attachment.id);

  if (attachment.memberId === input.actorId) {
    const result = await runMutation({
      sql,
      mutation: attachmentDeleteMutation,
      input: { attachmentId: attachment.id },
      apply: async (tx) => {
        await softDeleteAttachment(tx, attachment.id, input.actorId);
        return {
          postIds: references.map((reference) => reference.postId),
          topicIds: [...new Set(references.map((reference) => reference.topicId))],
        };
      },
    });

    return { ok: true, ...result };
  }

  if (input.postId === undefined) {
    return { ok: false, code: "forbidden" };
  }

  const reference = references.find((candidate) => candidate.postId === input.postId);

  if (reference === undefined) {
    return { ok: false, code: "not_found" };
  }

  const tree = await loadForumTree(sql);
  const allowed = await can(sql, input.actorId, "edit", {
    forumId: reference.forumId,
    tree,
    sessionId: input.sessionId ?? null,
  });

  if (!allowed) {
    return { ok: false, code: "forbidden" };
  }

  const result = await runMutation({
    sql,
    mutation: attachmentDeleteMutation,
    input: { attachmentId: attachment.id },
    apply: async (tx) => {
      await unlinkAttachmentFromPost(tx, reference.postId, attachment.id);
      return { postIds: [reference.postId], topicIds: [reference.topicId] };
    },
  });

  return { ok: true, ...result };
}
