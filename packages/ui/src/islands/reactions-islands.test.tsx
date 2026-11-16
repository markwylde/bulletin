import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PostReputation } from "./PostReputation.tsx";
import { Reactions } from "./Reactions.tsx";

const reactionProps = {
  postId: "12",
  canReact: true,
  reactions: [
    { id: "1", icon: "👍", label: "Like", count: 3, enabled: true },
    { id: "2", icon: "🙏", label: "Thanks", count: 0, enabled: true },
  ],
  labels: {
    bar: "Reactions",
    pick: "React",
    remove: "Remove your reaction",
    whoReacted: "Who reacted",
    close: "Close",
    loading: "Loading…",
    empty: "No reactions yet.",
    failed: "Your reaction could not be saved.",
    deletedMember: "Deleted member",
  },
} as const;

const reputationProps = {
  postId: "12",
  receiverId: "7",
  canGive: true,
  canNegative: true,
  locale: "en" as const,
  labels: {
    giveUp: "Give +1 reputation",
    giveDown: "Give -1 reputation",
    givenUp: "You gave +1",
    givenDown: "You gave -1",
    failed: "Could not give reputation.",
    dailyLimit: "The limit resets at %s.",
    minPosts: "You need %s posts.",
    negativeNotAllowed: "Negative reputation is not allowed.",
    cannotReceive: "This member does not receive reputation.",
    alreadyGiven: "You already gave reputation.",
    ownPost: "You cannot rate your own post.",
  },
} as const;

describe("reaction and reputation islands honour their flags", () => {
  test("the reaction bar renders only when the reactions flag is on", () => {
    expect(
      renderToStaticMarkup(<Reactions {...reactionProps} flags={{ reactions: false }} />),
    ).toBe("");
    expect(
      renderToStaticMarkup(<Reactions {...reactionProps} flags={{ reactions: true }} />),
    ).toContain("data-reaction-bar");
  });

  test("the reputation controls render only when the reputation flag is on", () => {
    expect(
      renderToStaticMarkup(<PostReputation {...reputationProps} flags={{ reputation: false }} />),
    ).toBe("");
    expect(
      renderToStaticMarkup(<PostReputation {...reputationProps} flags={{ reputation: true }} />),
    ).toContain('data-reputation-vote="1"');
  });

  test("only used reactions sit in the bar; the rest wait in the closed picker", () => {
    const html = renderToStaticMarkup(<Reactions {...reactionProps} flags={{ reactions: true }} />);
    const picker = html.slice(html.indexOf("data-reaction-picker"));

    expect(html).toContain("data-reaction-add");
    expect(html.indexOf('data-reaction-pick="1"')).toBeLessThan(html.indexOf("data-reaction-add"));
    expect(picker).toContain('data-reaction-pick="2"');
    expect(picker).not.toContain('data-reaction-pick="1"');
    expect(html).toMatch(/data-reaction-picker="true" hidden=""/);
  });

  test("viewers who cannot react see used totals only, with no picker", () => {
    const html = renderToStaticMarkup(
      <Reactions {...reactionProps} canReact={false} flags={{ reactions: true }} />,
    );

    expect(html).toContain('data-reaction-total="1"');
    expect(html).not.toContain('data-reaction-total="2"');
    expect(html).not.toContain("data-reaction-add");
  });
});
