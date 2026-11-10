import { describe, expect, test } from "bun:test";
import { renderContent } from "./pipeline.ts";
import type { MentionResolver } from "./types.ts";

const mentions: MentionResolver = {
  async resolveById(id) {
    return id === "42"
      ? { id: "42", displayName: "Regular Member One", url: "/profile/42-regular-member-one" }
      : null;
  },
  async resolve(name) {
    if (name.toLowerCase() === "jane") {
      return { id: "42", displayName: "Jane", url: "/profile/42-jane" };
    }

    if (name.toLowerCase() === "jo") {
      return { id: "43", displayName: "Jo", url: "/profile/43-jo" };
    }

    return null;
  },
};

function options() {
  return {
    profile: "post" as const,
    context: { kind: "forum_post" as const, forumId: "1" },
    authorId: "7",
    mentions,
    emoticons: [{ code: "smile", src: "/files/emoticons/smile.png", alt: "smile" }],
  };
}

describe("inline extensions", () => {
  test("mentions link to the member profile and are recorded once", async () => {
    const result = await renderContent("Hi @Jane and @jane, plus @ghost.", options());

    expect(result.bodyHtml).toContain('href="/profile/42-jane"');
    expect(result.bodyHtml.match(/href="\/profile\/42-jane"/g)).toHaveLength(2);
    expect(result.bodyHtml).toContain("@Jane");
    expect(result.bodyHtml).toContain("@ghost");
    expect(result.mentionedMemberIds).toEqual(["42"]);
  });

  test("trailing punctuation is not part of a mention", async () => {
    const result = await renderContent("Thanks @Jane.", options());

    expect(result.bodyHtml).toContain("@Jane");
    expect(result.bodyHtml).toContain(".");
    expect(result.mentionedMemberIds).toEqual(["42"]);
  });

  test("resolves the unambiguous multiword mention token", async () => {
    const result = await renderContent("Hi @[Regular Member One](member:42)!", options());

    expect(result.bodyHtml).toContain('href="/profile/42-regular-member-one"');
    expect(result.bodyHtml).toContain("@Regular Member One");
    expect(result.bodyHtml).not.toContain("member:42");
    expect(result.mentionedMemberIds).toEqual(["42"]);
  });

  test("mentions inside code are left as text", async () => {
    const result = await renderContent("`@Jane` and\n\n```\n@Jane\n```", options());

    expect(result.bodyHtml).not.toContain("/profile/42-jane");
    expect(result.mentionedMemberIds).toEqual([]);
  });

  test("known emoticons render with alt text", async () => {
    const result = await renderContent("Hello :smile:", options());

    expect(result.bodyHtml).toContain('src="/files/emoticons/smile.png"');
    expect(result.bodyHtml).toContain('alt="smile"');
    expect(result.bodyHtml).toContain('class="emoticon"');
  });

  test("unknown emoticon codes stay as text", async () => {
    const result = await renderContent("Hello :unknown:", options());

    expect(result.bodyHtml).toContain(":unknown:");
    expect(result.bodyHtml).not.toContain("<img");
  });

  test("emoticons are not expanded inside code", async () => {
    const result = await renderContent("`:smile:`", options());

    expect(result.bodyHtml).toContain(":smile:");
    expect(result.bodyHtml).not.toContain("<img");
  });

  test("spoilers render inside a spoiler element", async () => {
    const result = await renderContent("Before ||the secret|| after", options());

    expect(result.bodyHtml).toContain('<span class="spoiler">the secret</span>');
    expect(result.bodyText).toContain("the secret");
  });

  test("fenced code is highlighted server-side", async () => {
    const result = await renderContent("```ts\nconst answer = 42;\n```", options());

    expect(result.bodyHtml).toContain('class="hljs language-ts"');
    expect(result.bodyHtml).toContain("hljs-keyword");
  });
});
