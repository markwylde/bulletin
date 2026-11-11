import { describe, expect, test } from "bun:test";
import { renderContent } from "./pipeline.ts";
import {
  hashUnfurlUrl,
  normaliseUnfurlUrl,
  resolveUnfurlPlaceholders,
  type UnfurlPreview,
} from "./unfurls.ts";

function options() {
  return {
    profile: "post" as const,
    context: { kind: "forum_post" as const, forumId: "1" },
    authorId: "7",
    unfurls: true,
  };
}

const PREVIEW: UnfurlPreview = {
  kind: "opengraph",
  url: "https://example.com/article",
  title: "Mock link preview for example.com",
  description: "Canned OpenGraph description",
  siteName: "Example",
  provider: null,
  imageUrl: "https://example.com/image.png",
  imageProxy: null,
};

describe("unfurls", () => {
  test("normalises URLs and hashes them deterministically", () => {
    const normalised = normaliseUnfurlUrl("https://example.com/article#section");

    expect(normalised).toBe("https://example.com/article");
    expect(normalised === null ? null : hashUnfurlUrl(normalised)).toBe(
      hashUnfurlUrl("https://example.com/article"),
    );
    expect(hashUnfurlUrl("https://example.com/article")).toMatch(/^[0-9a-f]{64}$/);
    expect(normaliseUnfurlUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseUnfurlUrl("https://user:pass@example.com")).toBeNull();
  });

  test("a standalone public link becomes a placeholder with its hash", async () => {
    const url = "https://example.com/article";
    const normalised = normaliseUnfurlUrl(url);

    if (normalised === null) {
      throw new Error("URL did not normalise");
    }

    const result = await renderContent(url, options());

    expect(result.bodyHtml).toContain("<bl-unfurl");
    expect(result.bodyHtml).toContain(`data-url="${url}"`);
    expect(result.bodyHtml).toContain(`data-url-hash="${hashUnfurlUrl(normalised)}"`);
    expect(result.bodyText).toBe(url);
  });

  test("a cached preview renders a text-only card with two lines", async () => {
    const url = "https://example.com/article";
    const result = await renderContent(url, options());

    const html = await resolveUnfurlPlaceholders(result.bodyHtml, {
      async load() {
        return PREVIEW;
      },
    });

    expect(html).toContain('class="unfurl-card"');
    expect(html).toContain("Mock link preview for example.com");
    expect(html).toContain("Canned OpenGraph description");
    expect(html).toContain("Example");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data-url-hash");
  });

  test("renders only the worker-proxied image path, never the third-party URL", async () => {
    const result = await renderContent("https://example.com/article", options());
    const proxy = `/unfurl/${"a".repeat(64)}`;
    const html = await resolveUnfurlPlaceholders(result.bodyHtml, {
      async load() {
        return { ...PREVIEW, imageUrl: "https://tracker.example/pixel.png", imageProxy: proxy };
      },
    });

    expect(html).toContain(`<img class="unfurl-image" src="${proxy}"`);
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("example.com/image.png");
  });

  test("preview text is escaped", async () => {
    const result = await renderContent("https://example.com/article", options());
    const html = await resolveUnfurlPlaceholders(result.bodyHtml, {
      async load() {
        return { ...PREVIEW, title: "<script>alert(1)</script>" };
      },
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("without a cached preview the link stays plain", async () => {
    const result = await renderContent("https://example.com/article", options());
    const html = await resolveUnfurlPlaceholders(result.bodyHtml, {
      async load() {
        return null;
      },
    });

    expect(html).toContain('class="unfurl-link"');
    expect(html).toContain('href="https://example.com/article"');
    expect(html).not.toContain("unfurl-card");
  });

  test("a forged javascript placeholder never renders a link", async () => {
    const html = await resolveUnfurlPlaceholders(
      '<bl-unfurl data-url="javascript:alert(1)" data-url-hash="abc">x</bl-unfurl>',
      {
        async load() {
          return null;
        },
      },
    );

    expect(html).toBe("");
  });

  test("a URL with an ampersand survives the placeholder round trip", async () => {
    const url = "https://example.com/search?q=one&page=2";
    const result = await renderContent(url, options());

    const html = await resolveUnfurlPlaceholders(result.bodyHtml, {
      async load() {
        return { ...PREVIEW, url };
      },
    });

    expect(html).toContain('href="https://example.com/search?q=one&amp;page=2"');
  });

  test("unfurls are off unless the caller enables them", async () => {
    const result = await renderContent("https://example.com/article", {
      profile: "post",
      context: { kind: "forum_post", forumId: "1" },
      authorId: "7",
    });

    expect(result.bodyHtml).not.toContain("<bl-unfurl");
    expect(result.bodyHtml).toContain("<a ");
  });
});
