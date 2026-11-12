import { describe, expect, test } from "bun:test";
import { type ApprovalInput, approvalDecision, needsApproval } from "./needs-approval.ts";

const author = {
  approvedPostCount: 0,
  groupRequiresApproval: false,
  groupQueueFirstPosts: 0,
  canApprove: false,
};

const forum = {
  requireApprovalTopics: false,
  requireApprovalPosts: false,
};

const board = { newMemberApprovalPosts: 0 };

function input(overrides: {
  readonly author?: Partial<typeof author>;
  readonly forum?: Partial<typeof forum>;
  readonly board?: Partial<typeof board>;
  readonly content?: Partial<ApprovalInput["content"]>;
}): ApprovalInput {
  return {
    author: { ...author, ...overrides.author },
    forum: { ...forum, ...overrides.forum },
    board: { ...board, ...overrides.board },
    content: { kind: "post", ...overrides.content },
  };
}

describe("needsApproval", () => {
  test("the default board holds nothing", () => {
    expect(approvalDecision(input({}))).toEqual({ hold: false, reason: null });
    expect(needsApproval(input({}))).toBe(false);
  });

  test("a content filter holds every kind of content, even from a moderator", () => {
    expect(
      approvalDecision(input({ author: { canApprove: true }, content: { filterFlagged: true } })),
    ).toEqual({ hold: true, reason: "filter" });
  });

  test("warning-imposed moderation wins over the ordinary forum source", () => {
    expect(
      approvalDecision(
        input({
          content: { warningModeration: true, kind: "topic" },
          forum: { requireApprovalTopics: true },
        }),
      ),
    ).toEqual({ hold: true, reason: "warning" });
  });

  test("a moderator with approve is trusted with their own content", () => {
    expect(
      needsApproval(
        input({
          author: { canApprove: true },
          forum: { requireApprovalTopics: true, requireApprovalPosts: true },
          content: { kind: "topic" },
        }),
      ),
    ).toBe(false);
  });

  test("a forum that requires topic approval holds topics but not replies", () => {
    expect(
      approvalDecision(
        input({ forum: { requireApprovalTopics: true }, content: { kind: "topic" } }),
      ),
    ).toEqual({ hold: true, reason: "forum" });
    expect(
      needsApproval(input({ forum: { requireApprovalTopics: true }, content: { kind: "post" } })),
    ).toBe(false);
  });

  test("a forum that requires post approval holds replies but not topics", () => {
    expect(
      approvalDecision(input({ forum: { requireApprovalPosts: true }, content: { kind: "post" } })),
    ).toEqual({ hold: true, reason: "forum" });
    expect(
      needsApproval(input({ forum: { requireApprovalPosts: true }, content: { kind: "topic" } })),
    ).toBe(false);
  });

  test("the group restriction holds both topics and replies", () => {
    expect(
      approvalDecision(
        input({ author: { groupRequiresApproval: true }, content: { kind: "topic" } }),
      ),
    ).toEqual({ hold: true, reason: "group" });
    expect(
      needsApproval(input({ author: { groupRequiresApproval: true }, content: { kind: "post" } })),
    ).toBe(true);
  });

  test("the board new-member threshold holds posts below N", () => {
    expect(
      approvalDecision(
        input({ board: { newMemberApprovalPosts: 3 }, author: { approvedPostCount: 2 } }),
      ),
    ).toEqual({ hold: true, reason: "new_member" });
    expect(
      needsApproval(
        input({ board: { newMemberApprovalPosts: 3 }, author: { approvedPostCount: 3 } }),
      ),
    ).toBe(false);
    expect(
      needsApproval(
        input({ board: { newMemberApprovalPosts: 3 }, author: { approvedPostCount: 4 } }),
      ),
    ).toBe(false);
  });

  test("the group threshold and the board threshold combine with the larger value", () => {
    expect(
      needsApproval(input({ author: { groupQueueFirstPosts: 5, approvedPostCount: 4 } })),
    ).toBe(true);
    expect(
      needsApproval(
        input({
          author: { groupQueueFirstPosts: 2, approvedPostCount: 4 },
          board: { newMemberApprovalPosts: 5 },
        }),
      ),
    ).toBe(true);
    expect(
      needsApproval(
        input({
          author: { groupQueueFirstPosts: 5, approvedPostCount: 5 },
          board: { newMemberApprovalPosts: 3 },
        }),
      ),
    ).toBe(false);
  });

  test("zero thresholds are off regardless of the approved count", () => {
    expect(
      needsApproval(
        input({
          author: { groupQueueFirstPosts: 0, approvedPostCount: 0 },
          board: { newMemberApprovalPosts: 0 },
        }),
      ),
    ).toBe(false);
  });

  test("precedence is filter, warning, moderator, forum, group, new member", () => {
    const everything = input({
      author: {
        approvedPostCount: 0,
        groupRequiresApproval: true,
        groupQueueFirstPosts: 10,
        canApprove: false,
      },
      forum: { requireApprovalTopics: true, requireApprovalPosts: true },
      board: { newMemberApprovalPosts: 10 },
      content: { kind: "topic", warningModeration: true, filterFlagged: true },
    });

    expect(approvalDecision(everything)).toEqual({ hold: true, reason: "filter" });
    expect(
      approvalDecision({ ...everything, content: { kind: "topic", warningModeration: true } }),
    ).toEqual({ hold: true, reason: "warning" });
    expect(approvalDecision({ ...everything, content: { kind: "topic" } })).toEqual({
      hold: true,
      reason: "forum",
    });
    expect(
      approvalDecision({
        ...everything,
        content: { kind: "post" },
        forum: { requireApprovalTopics: true, requireApprovalPosts: false },
      }),
    ).toEqual({ hold: true, reason: "group" });
  });
});
