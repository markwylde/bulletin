import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedLinks } from "./FeedLinks.tsx";

const LABELS = { label: "Feeds", rss: "RSS feed", atom: "Atom feed" };

describe("FeedLinks island", () => {
  test("renders nothing when useFlag sees feeds off", () => {
    const html = renderToStaticMarkup(
      createElement(FeedLinks, { flags: { feeds: false }, labels: LABELS }),
    );

    expect(html).toBe("");
  });

  test("renders both feed links when useFlag sees feeds on", () => {
    const html = renderToStaticMarkup(
      createElement(FeedLinks, { flags: { feeds: true }, labels: LABELS }),
    );

    expect(html).toContain("data-feed-links");
    expect(html).toContain('href="/feed.xml"');
    expect(html).toContain('href="/feed.atom"');
    expect(html).toContain("RSS feed");
    expect(html).toContain("Atom feed");
  });
});
