import type { SQL } from "bun";
import { readBoardSettings } from "../../board/index.ts";
import { can } from "../../permissions/can.ts";
import { loadMergedGroupSettings } from "../../permissions/store.ts";
import type { ForumTree } from "../../permissions/tree.ts";
import { loadForumTree } from "../../permissions/tree-store.ts";
import {
  type ApprovalContent,
  type ApprovalInput,
  approvalDecision,
  type HoldReason,
} from "../needs-approval.ts";

interface ForumApprovalRow {
  readonly require_approval_topics: boolean;
  readonly require_approval_posts: boolean;
}

/** The two per-forum approval switches; categories simply never require approval. */
export async function readForumApproval(
  sql: SQL,
  forumId: string,
): Promise<{ readonly requireApprovalTopics: boolean; readonly requireApprovalPosts: boolean }> {
  const rows = (await sql`
    SELECT require_approval_topics, require_approval_posts
    FROM core.forums
    WHERE id = ${forumId}
  `) as ForumApprovalRow[];
  const row = rows[0];

  return {
    requireApprovalTopics: row?.require_approval_topics ?? false,
    requireApprovalPosts: row?.require_approval_posts ?? false,
  };
}

export interface ApprovalContextInput {
  readonly actorId: string;
  readonly forumId: string;
  readonly content: ApprovalContent;
  readonly tree?: ForumTree;
  readonly sessionId?: string | null;
}

/**
 * Loads exactly the facts `needsApproval` needs. Call it inside the posting transaction so
 * the decision uses the same snapshot as the write.
 */
export async function loadApprovalInput(
  sql: SQL,
  input: ApprovalContextInput,
): Promise<ApprovalInput> {
  const forum = await readForumApproval(sql, input.forumId);
  const board = await readBoardSettings(sql);
  const settings = await loadMergedGroupSettings(sql, input.actorId);
  const memberRows = (await sql`
    SELECT post_count FROM core.members WHERE id = ${input.actorId}
  `) as Array<{ post_count: number }>;
  const tree = input.tree ?? (await loadForumTree(sql));
  const canApprove = await can(sql, input.actorId, "approve", {
    forumId: input.forumId,
    tree,
    sessionId: input.sessionId ?? null,
  });

  return {
    author: {
      approvedPostCount: memberRows[0]?.post_count ?? 0,
      groupRequiresApproval: settings["posting.posts_require_approval"] === true,
      groupQueueFirstPosts: Number(settings["posting.queue_first_posts"] ?? 0),
      canApprove,
    },
    forum,
    board: { newMemberApprovalPosts: board.newMemberApprovalPosts },
    content: input.content,
  };
}

export interface ApprovalResult {
  readonly hold: boolean;
  readonly reason: HoldReason | null;
}

export async function decideApproval(
  sql: SQL,
  input: ApprovalContextInput,
): Promise<ApprovalResult> {
  return approvalDecision(await loadApprovalInput(sql, input));
}
