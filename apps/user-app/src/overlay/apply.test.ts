import { describe, expect, test } from "bun:test";
import { applyOverlay, type OverlayTarget } from "./apply.ts";

function target(): {
  readonly target: OverlayTarget;
  readonly unread: string[];
  readonly counts: string[];
  readonly tokens: string[];
  readonly dismissed: string[];
  readonly drafts: string[];
  readonly polls: string[];
  readonly unreadForums: string[];
  readonly firstUnread: string[];
  readonly editable: string[];
  readonly follows: string[];
  readonly reactions: string[];
  readonly reputation: string[];
} {
  const unread: string[] = [];
  const counts: string[] = [];
  const tokens: string[] = [];
  const dismissed: string[] = [];
  const drafts: string[] = [];
  const polls: string[] = [];
  const unreadForums: string[] = [];
  const firstUnread: string[] = [];
  const editable: string[] = [];
  const follows: string[] = [];
  const reactions: string[] = [];
  const reputation: string[] = [];

  return {
    unread,
    counts,
    tokens,
    dismissed,
    drafts,
    polls,
    unreadForums,
    firstUnread,
    editable,
    follows,
    reactions,
    reputation,
    target: {
      unreadSlots: (topicId) => [
        { markUnread: () => unread.push(topicId) },
        { markUnread: () => unread.push(`${topicId} (second slot)`) },
      ],
      forumUnreadSlots: (forumId) => [{ markUnread: () => unreadForums.push(forumId) }],
      countSlots: (name) => [{ setCount: (count) => counts.push(`${name}=${count}`) }],
      storeCsrfToken: (token) => tokens.push(token),
      hideAnnouncement: (announcementId) => dismissed.push(announcementId),
      setDraft: (draft) => drafts.push(`${draft.contextKey}:${draft.bodyMd}`),
      setPollVoted: (pollId, hasVoted) => polls.push(`${pollId}:${hasVoted ? "yes" : "no"}`),
      setFirstUnread: (topicId, url) => firstUnread.push(`${topicId}:${url}`),
      setEditablePosts: (posts) =>
        editable.push(...posts.map((post) => `${post.postId}:${post.canEdit ? "edit" : "read"}`)),
      setFollow: (context, following) => follows.push(`${context}:${following ? "yes" : "no"}`),
      setReactions: (states) =>
        reactions.push(
          ...states.map(
            (state) =>
              `${state.postId}:${state.reactionId ?? "none"}:${state.own ? "own" : "other"}`,
          ),
        ),
      setReputation: (states) =>
        reputation.push(
          ...states.map(
            (state) => `${state.postId}:${state.points ?? "none"}:${state.own ? "own" : "other"}`,
          ),
        ),
    },
  };
}

describe("overlay applier", () => {
  test("marks every rendered slot for each unread topic", () => {
    const fixture = target();

    applyOverlay(fixture.target, { unread: ["201", "202"] });

    expect(fixture.unread).toEqual(["201", "201 (second slot)", "202", "202 (second slot)"]);
  });

  test("applies fixture counts to their slots and floors invalid values", () => {
    const fixture = target();

    applyOverlay(fixture.target, {
      counts: { notifications: 3, conversations: -2 },
    });

    expect(fixture.counts).toEqual(["notifications=3", "conversations=0"]);
  });

  test("stores a server-issued CSRF token and ignores empty ones", () => {
    const fixture = target();

    applyOverlay(fixture.target, { csrfToken: "token-123" });
    applyOverlay(fixture.target, { csrfToken: "" });

    expect(fixture.tokens).toEqual(["token-123"]);
  });

  test("hides the announcements the member dismissed and ignores unsafe ids", () => {
    const fixture = target();

    applyOverlay(fixture.target, {
      dismissedAnnouncements: ["7", "x", "9"],
    });

    expect(fixture.dismissed).toEqual(["7", "9"]);
  });

  test("marks unread forums and sets safe first-unread links", () => {
    const fixture = target();

    applyOverlay(fixture.target, {
      unreadForums: ["3", "x"],
      firstUnread: [
        { topicId: "9", url: "/topic/9-hello/page/2#post-30" },
        { topicId: "10", url: "javascript:alert(1)" },
      ],
    });

    expect(fixture.unreadForums).toEqual(["3"]);
    expect(fixture.firstUnread).toEqual(["9:/topic/9-hello/page/2#post-30"]);
  });

  test("delivers private editable-post controls", () => {
    const fixture = target();

    applyOverlay(fixture.target, {
      editablePosts: [
        {
          postId: "7",
          bodyMd: "x",
          canEdit: true,
          canDelete: true,
          canRedact: false,
          canViewHistory: false,
        },
        { postId: "8", canEdit: false, canDelete: true, canRedact: false, canViewHistory: false },
      ],
    });

    expect(fixture.editable).toEqual(["7:edit", "8:read"]);
  });

  test("applies the member's poll vote state and ignores unsafe ids", () => {
    const fixture = target();

    applyOverlay(fixture.target, {
      polls: [
        { pollId: "4", hasVoted: true },
        { pollId: "x", hasVoted: true },
        { pollId: "5", hasVoted: false },
      ],
    });

    expect(fixture.polls).toEqual(["4:yes", "5:no"]);
  });

  test("delivers the member's draft for the editor context", () => {
    const fixture = target();

    applyOverlay(fixture.target, {
      draft: { contextKey: "reply:topic:1", bodyMd: "unsaved", updatedAt: "2026-11-10T00:00:00Z" },
    });
    applyOverlay(fixture.target, { draft: { contextKey: "x", bodyMd: 1 } } as never);

    expect(fixture.drafts).toEqual(["reply:topic:1:unsaved"]);
  });

  test("marks the follow targets the member follows and ignores malformed keys", () => {
    const fixture = target();

    applyOverlay(fixture.target, {
      follows: { "topic:12": true, "forum:3": false, "topic:x": true, "member:0": true },
    });

    expect(fixture.follows).toEqual(["topic:12:yes", "forum:3:no"]);
  });

  test("marks the member's own reaction and own posts, ignoring unsafe ids", () => {
    const fixture = target();

    applyOverlay(fixture.target, {
      reactions: [
        { postId: "7", reactionId: "2", own: false },
        { postId: "8", reactionId: null, own: true },
        { postId: "x", reactionId: "2", own: false },
        { postId: "9", reactionId: "x", own: false },
      ],
    });

    expect(fixture.reactions).toEqual(["7:2:other", "8:none:own"]);
  });

  test("marks the member's own reputation vote and own posts, ignoring unsafe ids", () => {
    const fixture = target();

    applyOverlay(fixture.target, {
      reputation: [
        { postId: "7", points: 1, own: false },
        { postId: "8", points: null, own: true },
        { postId: "x", points: -1, own: false },
        { postId: "9", points: 2, own: false },
      ],
    });

    expect(fixture.reputation).toEqual(["7:1:other", "8:none:own"]);
  });

  test("ignores unknown payload fields and keeps applying the rest", () => {
    const fixture = target();

    applyOverlay(fixture.target, {
      unread: ["201"],
      counts: { notifications: 1 },
      csrfToken: "token",
      // Extra fields from a newer server are harmless.
      ...{ unexpected: true },
    });

    expect(fixture.unread).toEqual(["201", "201 (second slot)"]);
    expect(fixture.counts).toEqual(["notifications=1"]);
    expect(fixture.tokens).toEqual(["token"]);
  });
});
