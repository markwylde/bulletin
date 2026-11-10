import { describe, expect, test } from "bun:test";
import { DEFAULT_EMBED_PROVIDERS, embedIframeSrc, matchEmbedProvider } from "./embeds.ts";
import { renderContent } from "./pipeline.ts";

function options(profile: "post" | "signature" = "post") {
  return {
    profile,
    context: { kind: "forum_post" as const, forumId: "1" },
    authorId: "7",
    embeds: DEFAULT_EMBED_PROVIDERS,
    unfurls: true,
  };
}

describe("embed allowlist", () => {
  test("matches YouTube and Vimeo URLs", () => {
    expect(
      matchEmbedProvider("https://www.youtube.com/watch?v=dQw4w9WgXcQ", DEFAULT_EMBED_PROVIDERS),
    ).toMatchObject({
      provider: { key: "youtube" },
      id: "dQw4w9WgXcQ",
      embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    });
    expect(
      matchEmbedProvider("https://youtu.be/dQw4w9WgXcQ?t=5", DEFAULT_EMBED_PROVIDERS),
    ).toMatchObject({ provider: { key: "youtube" } });
    expect(
      matchEmbedProvider("https://vimeo.com/123456789", DEFAULT_EMBED_PROVIDERS),
    ).toMatchObject({
      provider: { key: "vimeo" },
      embedUrl: "https://player.vimeo.com/video/123456789",
    });
  });

  test("rejects other hosts, non-http URLs and credential URLs", () => {
    expect(matchEmbedProvider("https://example.com/watch?v=x", DEFAULT_EMBED_PROVIDERS)).toBeNull();
    expect(matchEmbedProvider("javascript:alert(1)", DEFAULT_EMBED_PROVIDERS)).toBeNull();
    expect(
      matchEmbedProvider(
        "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ",
        DEFAULT_EMBED_PROVIDERS,
      ),
    ).toBeNull();
  });

  test("rejects an id that the provider template cannot use safely", () => {
    const youtube = DEFAULT_EMBED_PROVIDERS.find((provider) => provider.key === "youtube");

    if (youtube === undefined) {
      throw new Error("YouTube provider missing");
    }

    expect(embedIframeSrc(youtube, "../../evil")).toBeNull();
  });

  test("renders a provider link as the wrapper iframe", async () => {
    const result = await renderContent("https://www.youtube.com/watch?v=dQw4w9WgXcQ", options());

    expect(result.bodyHtml).toContain('<div class="embed embed-youtube">');
    expect(result.bodyHtml).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(result.bodyHtml).toContain('title="YouTube"');
    expect(result.bodyHtml).not.toContain("<bl-embed");
  });

  test("a non-provider standalone link is not embedded", async () => {
    const result = await renderContent("https://example.com/article", {
      ...options(),
      unfurls: false,
    });

    expect(result.bodyHtml).not.toContain("<iframe");
    expect(result.bodyHtml).toContain('rel="nofollow ugc noopener"');
  });

  test("a link inside a sentence is never embedded", async () => {
    const result = await renderContent(
      "Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ here",
      options(),
    );

    expect(result.bodyHtml).not.toContain("<iframe");
  });

  test("raw iframes and forged placeholders cannot create players", async () => {
    const result = await renderContent(
      '<iframe src="https://evil.example"></iframe>\n\n<bl-embed data-provider="youtube" data-embed-id="../../evil"></bl-embed>',
      options(),
    );

    expect(result.bodyHtml).not.toContain("<iframe");
    expect(result.bodyHtml).not.toContain("<bl-embed");
  });

  test("signatures never get embeds", async () => {
    const result = await renderContent(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      options("signature"),
    );

    expect(result.bodyHtml).not.toContain("<iframe");
    expect(result.bodyHtml).toContain("youtube.com");
  });
});
