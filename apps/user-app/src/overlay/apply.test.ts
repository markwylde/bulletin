import { describe, expect, test } from "bun:test";
import { applyOverlay, type OverlayTarget } from "./apply.ts";

function target(): {
  readonly target: OverlayTarget;
  readonly unread: string[];
  readonly counts: string[];
  readonly tokens: string[];
} {
  const unread: string[] = [];
  const counts: string[] = [];
  const tokens: string[] = [];

  return {
    unread,
    counts,
    tokens,
    target: {
      unreadSlots: (topicId) => [
        { markUnread: () => unread.push(topicId) },
        { markUnread: () => unread.push(`${topicId} (second slot)`) },
      ],
      countSlots: (name) => [{ setCount: (count) => counts.push(`${name}=${count}`) }],
      storeCsrfToken: (token) => tokens.push(token),
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
