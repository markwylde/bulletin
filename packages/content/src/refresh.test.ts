import { describe, expect, test } from "bun:test";
import { DEFAULT_EMBED_PROVIDERS } from "./embeds.ts";
import { renderContent } from "./pipeline.ts";
import { refreshStoredHtml } from "./refresh.ts";
import type { QuoteSnapshotDraft, QuoteSource } from "./types.ts";

const SOURCE: QuoteSource = {
  ref: { kind: "post", id: "5" },
  sourceAuthorId: "2",
  bodyMd: "The source says **zebra**",
  contextId: "3",
};

const QUOTES = {
  resolver: {
    canRead: async () => true,
    load: async () => SOURCE,
  },
  snapshots: {
    create: async (_draft: QuoteSnapshotDraft) => "11",
  },
};

const MARKDOWN = [
  "Before",
  "",
  ':::quote{source="post:5"}',
  "quoted text is not trusted",
  ":::",
  "",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
].join("\n");

async function rendered() {
  return renderContent(MARKDOWN, {
    profile: "post",
    context: { kind: "forum_post", forumId: "1" },
    authorId: "7",
    embeds: DEFAULT_EMBED_PROVIDERS,
    quotes: QUOTES,
  });
}

describe("refresh after a version upgrade", () => {
  test("keeps quote placeholders and allowlisted players instead of erasing them", async () => {
    const original = await rendered();

    expect(original.bodyHtml).toContain("<bl-quote");
    expect(original.bodyHtml).toContain('<div class="embed embed-youtube">');

    const refreshed = await refreshStoredHtml(original.bodyHtml, {
      profile: "post",
      embedProviders: DEFAULT_EMBED_PROVIDERS,
    });

    expect(refreshed.bodyHtml).toBe(original.bodyHtml);
    // Quoted text is still excluded from derived text (ADR 0007).
    expect(refreshed.bodyText).toBe(original.bodyText);
    expect(refreshed.bodyText).not.toContain("zebra");
  });

  test("rebuilds the player from the provider template rather than trusting stored markup", async () => {
    const stored =
      '<div class="embed embed-youtube">' +
      '<iframe src="https://www.youtube-nocookie.com/embed/abc123" width="9999" ' +
      'onload="steal()" title="forged"></iframe></div>';
    const refreshed = await refreshStoredHtml(stored, {
      profile: "post",
      embedProviders: DEFAULT_EMBED_PROVIDERS,
    });

    expect(refreshed.bodyHtml).toContain('src="https://www.youtube-nocookie.com/embed/abc123"');
    expect(refreshed.bodyHtml).toContain('title="YouTube"');
    expect(refreshed.bodyHtml).toContain('loading="lazy"');
    expect(refreshed.bodyHtml).not.toContain("onload");
    expect(refreshed.bodyHtml).not.toContain("9999");
    expect(refreshed.bodyHtml).not.toContain("forged");
  });

  test("drops forged quote references, unknown iframes and players without an allowlist", async () => {
    const stored =
      '<bl-quote data-source-kind="forum" data-source="5" data-snapshot="11"></bl-quote>' +
      '<bl-quote data-source-kind="post" data-source="5x" data-snapshot="11"></bl-quote>' +
      '<iframe src="https://evil.example/embed"></iframe>';

    const refreshed = await refreshStoredHtml(stored, {
      profile: "post",
      embedProviders: DEFAULT_EMBED_PROVIDERS,
    });

    expect(refreshed.bodyHtml).not.toContain("<bl-quote");
    expect(refreshed.bodyHtml).not.toContain("iframe");
    expect(refreshed.bodyHtml).not.toContain("evil.example");

    const noAllowlist = await refreshStoredHtml(
      '<div class="embed embed-youtube">' +
        '<iframe src="https://www.youtube-nocookie.com/embed/abc123"></iframe></div>',
      { profile: "post" },
    );

    expect(noAllowlist.bodyHtml).not.toContain("iframe");
  });

  test("still strips untrusted markup from refreshed content", async () => {
    const refreshed = await refreshStoredHtml(
      '<p>safe</p><script>alert(1)</script><img src="x" onerror="alert(1)">',
      { profile: "post", embedProviders: DEFAULT_EMBED_PROVIDERS },
    );

    expect(refreshed.bodyHtml).toContain("<p>safe</p>");
    expect(refreshed.bodyHtml).not.toContain("<script");
    expect(refreshed.bodyHtml).not.toContain("onerror");
  });
});
