import { describe, expect, test } from "bun:test";
import { markdownForSave, roundTripMarkdown } from "./headless.ts";

const CORPUS = [
  "# Heading\n\nA paragraph with **bold**, *italic*, `code` and [a link](https://example.com).\n",
  "- one\n- two\n- three\n",
  "1. first\n2. second\n",
  "> a quote\n\n> a second paragraph\n",
  "```ts\nconst answer = 42;\n```\n",
  "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
  "- [x] done\n- [ ] todo\n",
  "~~struck~~\n",
  "A line  \nwith a hard break.\n",
];

describe("Milkdown headless round trip", () => {
  for (const [index, markdown] of CORPUS.entries()) {
    test(`corpus fixture ${index + 1} is stable`, async () => {
      const once = await roundTripMarkdown(markdown);
      const twice = await roundTripMarkdown(once);

      expect(twice).toBe(once);
    });
  }

  test("keeps the supported commonmark/GFM constructs", async () => {
    const output = await roundTripMarkdown(
      "# Heading\n\n**bold** *italic* `code` [link](https://example.com)\n",
    );

    expect(output).toContain("# Heading");
    expect(output).toContain("**bold**");
    expect(output).toContain("*italic*");
    expect(output).toContain("`code`");
    expect(output).toContain("[link](https://example.com)");
  });

  test("an untouched document saves its exact original markdown", () => {
    const unknown = ":::disabled-plugin\nraw syntax [b]hi[/b]\n:::";

    expect(markdownForSave(unknown, "canonical rewrite", false)).toBe(unknown);
    expect(markdownForSave(unknown, "canonical rewrite", true)).toBe("canonical rewrite");
  });
});
