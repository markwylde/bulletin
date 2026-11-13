import { describe, expect, test } from "bun:test";
import { renderContent } from "./pipeline.ts";

const BASE = {
  profile: "post" as const,
  context: { kind: "forum_post" as const, forumId: "1" },
  authorId: "1",
};

describe("plugin content extensions", () => {
  test("passes plugin HTML through the core sanitiser", async () => {
    const rendered = await renderContent("hello", {
      ...BASE,
      pluginHtml: ['<div class="tip"><script>alert(1)</script><b>Tip</b></div>'],
    });

    expect(rendered.bodyHtml).toContain("Tip");
    expect(rendered.bodyHtml).not.toContain("<script");
    expect(rendered.bodyHtml).not.toContain("alert(1)");
  });

  test("strips plugin event handlers and javascript URLs", async () => {
    const rendered = await renderContent("hello", {
      ...BASE,
      pluginHtml: ['<a href="javascript:alert(1)" onclick="alert(1)">x</a>'],
    });

    expect(rendered.bodyHtml).not.toContain("javascript:");
    expect(rendered.bodyHtml).not.toContain("onclick");
  });
});
