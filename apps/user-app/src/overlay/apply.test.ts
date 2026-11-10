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
} {
  const unread: string[] = [];
  const counts: string[] = [];
  const tokens: string[] = [];
  const dismissed: string[] = [];
  const drafts: string[] = [];
  const polls: string[] = [];

  return {
    unread,
    counts,
    tokens,
    dismissed,
    drafts,
    polls,
    target: {
      unreadSlots: (topicId) => [
        { markUnread: () => unread.push(topicId) },
        { markUnread: () => unread.push(`${topicId} (second slot)`) },
      ],
      countSlots: (name) => [{ setCount: (count) => counts.push(`${name}=${count}`) }],
      storeCsrfToken: (token) => tokens.push(token),
      hideAnnouncement: (announcementId) => dismissed.push(announcementId),
      setDraft: (draft) => drafts.push(`${draft.contextKey}:${draft.bodyMd}`),
      setPollVoted: (pollId, hasVoted) => polls.push(`${pollId}:${hasVoted ? "yes" : "no"}`),
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
