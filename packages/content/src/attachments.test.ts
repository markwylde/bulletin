import { describe, expect, test } from "bun:test";
import { renderContent } from "./pipeline.ts";

function options() {
  return {
    profile: "post" as const,
    context: { kind: "forum_post" as const, forumId: "1" },
    authorId: "7",
  };
}

describe("attachment placeholders", () => {
  test("turns image syntax into an inline attachment placeholder", async () => {
    const result = await renderContent("![photo.jpg](attachment:42)", options());

    expect(result.bodyHtml).toContain(
      '<bl-attachment data-id="42" data-inline="true"></bl-attachment>',
    );
    expect(result.bodyHtml).not.toContain("attachment:42");
  });

  test("turns link syntax into a file attachment placeholder", async () => {
    const result = await renderContent("[report.pdf](attachment:43)", options());

    expect(result.bodyHtml).toContain(
      '<bl-attachment data-id="43" data-inline="false"></bl-attachment>',
    );
  });

  test("leaves non-attachment links and images alone", async () => {
    const result = await renderContent(
      "![x](https://example.test/x.png)\n\n[y](https://example.test/y)\n\n[z](attachment:abc)",
      options(),
    );

    expect(result.bodyHtml).toContain('src="https://example.test/x.png"');
    expect(result.bodyHtml).toContain('href="https://example.test/y"');
    expect(result.bodyHtml).not.toContain("bl-attachment");
  });

  test("signatures never render attachment placeholders", async () => {
    const result = await renderContent("![photo](attachment:42)", {
      profile: "signature",
      context: { kind: "forum_post", forumId: "1" },
      authorId: "7",
    });

    expect(result.bodyHtml).not.toContain("bl-attachment");
    // The sanitiser drops the unsafe `attachment:` image entirely.
    expect(result.bodyHtml).not.toContain("attachment:");
    expect(result.bodyHtml).not.toContain("<img");
  });
});
