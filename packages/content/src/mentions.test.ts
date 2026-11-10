import { describe, expect, test } from "bun:test";
import { applyMentionVisibility } from "./mentions.ts";
import { renderContent } from "./pipeline.ts";
import type { MentionResolver } from "./types.ts";

const mentions: MentionResolver = {
  async resolve(name) {
    return name.toLowerCase() === "jane"
      ? { id: "42", displayName: "Jane", url: "/profile/42-jane" }
      : null;
  },
};

function options() {
  return {
    profile: "rules" as const,
    context: { kind: "forum_post" as const, forumId: "1" },
    authorId: "7",
    mentions,
  };
}

describe("mention visibility", () => {
  test("the write pipeline marks mention links with the mentioned member", async () => {
    const result = await renderContent(
      "Hi @Jane, see [the docs](https://example.com/docs)",
      options(),
    );

    expect(result.bodyHtml).toContain('data-mention="42"');
    expect(result.bodyHtml).toContain('href="/profile/42-jane"');
  });

  test("an enabled viewer keeps mention links and ordinary links", async () => {
    const result = await renderContent(
      "Hi @Jane, see [the docs](https://example.com/docs)",
      options(),
    );
    const html = await applyMentionVisibility(result.bodyHtml, true);

    expect(html).toBe(result.bodyHtml);
    expect(html).toContain('href="/profile/42-jane"');
    expect(html).toContain('href="https://example.com/docs"');
  });

  test("a disabled viewer gets plain @name text but keeps ordinary links", async () => {
    const result = await renderContent(
      "Hi @Jane, see [the docs](https://example.com/docs)",
      options(),
    );
    const html = await applyMentionVisibility(result.bodyHtml, false);

    expect(html).toContain("@Jane");
    expect(html).not.toContain("/profile/42-jane");
    expect(html).not.toContain("data-mention");
    expect(html).toContain('href="https://example.com/docs"');
  });

  test("code spans that look like a mention are never marked", async () => {
    const result = await renderContent("`@Jane` and <span>@Jane</span>", options());
    const html = await applyMentionVisibility(result.bodyHtml, false);

    expect(html).not.toContain("data-mention");
    expect(html).toContain("@Jane");
  });
});
