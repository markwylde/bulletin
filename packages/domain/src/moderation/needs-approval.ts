/**
 * The approval decision (moderation design). It is deliberately pure: posting loads the
 * author, forum and board facts once and this function combines them, so every source of a
 * hold is unit-tested without a database.
 */

export const HOLD_REASONS = ["new_member", "group", "forum", "warning", "filter"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export type ApprovalContentKind = "topic" | "post";

export interface ApprovalAuthor {
  /** Approved (visible) posts, including future topic starters. */
  readonly approvedPostCount: number;
  /** The merged `posting.posts_require_approval` restriction. */
  readonly groupRequiresApproval: boolean;
  /** The merged `posting.queue_first_posts` value; zero means off. */
  readonly groupQueueFirstPosts: number;
  /** Authors who may approve in this forum are trusted with their own content. */
  readonly canApprove: boolean;
}

export interface ApprovalForum {
  readonly requireApprovalTopics: boolean;
  readonly requireApprovalPosts: boolean;
}

export interface ApprovalBoard {
  /** Board-wide new-member threshold; zero means off. */
  readonly newMemberApprovalPosts: number;
}

export interface ApprovalContent {
  readonly kind: ApprovalContentKind;
  /** A warning action currently puts the member on moderation. */
  readonly warningModeration?: boolean;
  /** A content filter flagged this item and its rule holds content. */
  readonly filterFlagged?: boolean;
}

export interface ApprovalInput {
  readonly author: ApprovalAuthor;
  readonly forum: ApprovalForum;
  readonly board: ApprovalBoard;
  readonly content: ApprovalContent;
}

export interface ApprovalDecision {
  readonly hold: boolean;
  readonly reason: HoldReason | null;
}

/**
 * Ordered so the reason the moderator sees is the most specific one: safety holds first,
 * then the author's group, then the forum, then the new-member threshold. A moderator with
 * `approve` is never held by the ordinary sources, but a filter or warning still applies.
 */
export function approvalDecision(input: ApprovalInput): ApprovalDecision {
  const { author, forum, board, content } = input;

  if (content.filterFlagged === true) {
    return { hold: true, reason: "filter" };
  }

  if (content.warningModeration === true) {
    return { hold: true, reason: "warning" };
  }

  if (author.canApprove) {
    return { hold: false, reason: null };
  }

  if (content.kind === "topic" && forum.requireApprovalTopics) {
    return { hold: true, reason: "forum" };
  }

  if (content.kind === "post" && forum.requireApprovalPosts) {
    return { hold: true, reason: "forum" };
  }

  if (author.groupRequiresApproval) {
    return { hold: true, reason: "group" };
  }

  const threshold = Math.max(board.newMemberApprovalPosts, author.groupQueueFirstPosts);

  if (threshold > 0 && author.approvedPostCount < threshold) {
    return { hold: true, reason: "new_member" };
  }

  return { hold: false, reason: null };
}

/** Convenience for callers that only branch on the result. */
export function needsApproval(input: ApprovalInput): boolean {
  return approvalDecision(input).hold;
}
