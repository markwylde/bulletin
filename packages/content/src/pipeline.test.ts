import { describe, expect, test } from "bun:test";
import { renderContent } from "./pipeline.ts";
import { SANITISER_VERSION } from "./replace-words.ts";
import type { ContentProfile } from "./types.ts";

function options(profile: ContentProfile = "post") {
  return {
    profile,
    context: { kind: "forum_post" as const, forumId: "1" },
    authorId: "7",
  };
}

const XSS_CORPUS = [
  '<img src=x onerror="alert(1)">',
  "<script>alert(1)</script>",
  '<a href="javascript:alert(1)">click</a>',
  '<div style="background:url(javascript:alert(1))">styled</div>',
  "<svg onload=alert(1)>svg</svg>",
  '<iframe src="https://example.com"></iframe>',
  "[link](javascript:alert(1))",
  "![image](javascript:alert(1))",
  "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
];

describe("markdown pipeline", () => {
  test("stores markdown and never interprets BBCode", async () => {
    const result = await renderContent("[b]hi[/b] **bold**", options());

    expect(result.bodyMd).toBe("[b]hi[/b] **bold**");
    expect(result.bodyHtml).toContain("[b]hi[/b]");
    expect(result.bodyHtml).toContain("<strong>bold</strong>");
    expect(result.bodyText).toContain("[b]hi[/b]");
  });

  test("supports GFM tables and task lists", async () => {
    const result = await renderContent("| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done", options());

    expect(result.bodyHtml).toContain("<table>");
    expect(result.bodyHtml).toContain('type="checkbox"');
  });

  test("strips event handlers and scripts from raw HTML", async () => {
    const result = await renderContent('<img src=x onerror="alert(1)">', options());

    expect(result.bodyHtml).not.toContain("onerror");
    expect(result.bodyHtml).not.toContain("<script");
  });

  test("adds the nofollow ugc noopener rel to every link", async () => {
    const result = await renderContent("[Bulletin](https://example.com)", options());

    expect(result.bodyHtml).toContain('rel="nofollow ugc noopener"');
  });

  test("signatures downgrade headings and remove tables", async () => {
    const result = await renderContent(
      "# Heading\n\n| a | b |\n| - | - |\n| 1 | 2 |",
      options("signature"),
    );

    expect(result.bodyHtml).not.toContain("<h1>");
    expect(result.bodyHtml).toContain("<strong>Heading</strong>");
    expect(result.bodyHtml).not.toContain("<table>");
  });

  test("profile fields keep inline formatting only", async () => {
    const result = await renderContent(
      "# Bio\n\n**bold** [link](https://example.com)\n\n![pic](https://example.com/x.png)",
      options("profile_field"),
    );

    expect(result.bodyHtml).not.toContain("<h1>");
    expect(result.bodyHtml).not.toContain("<img");
    expect(result.bodyHtml).toContain("<strong>bold</strong>");
  });

  test("re-rendering an edit reflects the new HTML and text immediately", async () => {
    const before = await renderContent("first version", options());
    const after = await renderContent("second version", options());

    expect(before.bodyHtml).toContain("first");
    expect(after.bodyHtml).toContain("second");
    expect(after.bodyText).toBe("second version");
  });

  test("records the current render and sanitiser versions", async () => {
    const result = await renderContent("hello", options());

    expect(result.renderVersion).toBeGreaterThan(0);
    expect(result.sanitiserVersion).toBe(SANITISER_VERSION);
  });

  test("the XSS corpus never emits executable markup for any profile", async () => {
    const profiles: readonly ContentProfile[] = ["post", "signature", "profile_field", "rules"];

    for (const profile of profiles) {
      for (const payload of XSS_CORPUS) {
        const result = await renderContent(payload, options(profile));
        const html = result.bodyHtml;

        expect(html.toLowerCase()).not.toContain("<script");
        expect(html.toLowerCase()).not.toContain("<iframe");
        expect(html.toLowerCase()).not.toContain("javascript:");
        expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
        expect(html).not.toMatch(/<[a-z][^>]*\sstyle\s*=/i);
      }
    }
  });
});
