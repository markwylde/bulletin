import { describe, expect, test } from "bun:test";
import type { Node as ProseNode, Schema } from "@milkdown/kit/prose/model";
import { Fragment } from "@milkdown/kit/prose/model";
import { markdownForSave, roundTripMarkdown } from "./headless.ts";
import type { EditorEmoticon } from "./types.ts";

const EMOTICONS: readonly EditorEmoticon[] = [
  { code: "smile", src: "/emoticons/smile.png", alt: "Smile" },
];

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
  ":::disabled-plugin\nraw [b]hi[/b]\n:::",
  "Mention @[Regular Member One](member:42) and :smile: and ||spoiler||.",
];

function editParagraph(
  document: ProseNode,
  schema: Schema,
  before: string,
  after: string,
): ProseNode {
  const paragraph = document.firstChild;

  if (paragraph === null) {
    throw new Error("Expected a paragraph");
  }

  const content = Fragment.fromArray([
    schema.text(`${before} `),
    ...paragraph.content.content,
    schema.text(` ${after}`),
  ]);

  return document.copy(
    Fragment.fromArray([
      paragraph.type.create(paragraph.attrs, content),
      ...document.content.content.slice(1),
    ]),
  );
}

describe("Milkdown headless round trip", () => {
  for (const [index, markdown] of CORPUS.entries()) {
    test(`corpus fixture ${index + 1} is stable`, async () => {
      const once = await roundTripMarkdown(markdown, { emoticons: EMOTICONS });
      const twice = await roundTripMarkdown(once, { emoticons: EMOTICONS });

      expect(twice).toBe(once);

      if (markdown.includes(":::disabled-plugin")) {
        expect(once).toContain(":::disabled-plugin\nraw [b]hi[/b]\n:::");
      }
    });
  }

  test("keeps the supported commonmark/GFM constructs", async () => {
    const output = await roundTripMarkdown(
      "# Heading\n\n**bold** *italic* `code` [link](https://example.com)\n",
      { emoticons: EMOTICONS },
    );

    expect(output).toContain("# Heading");
    expect(output).toContain("**bold**");
    expect(output).toContain("*italic*");
    expect(output).toContain("`code`");
    expect(output).toContain("[link](https://example.com)");
  });

  test("parses and serialises the browser's custom mention, emoticon and spoiler nodes", async () => {
    const kinds: string[] = [];
    const output = await roundTripMarkdown(
      "Mention @[Regular Member One](member:42) and :smile: and ||secret||.",
      {
        emoticons: EMOTICONS,
        edit(document) {
          document.descendants((node) => {
            if (node.type.name === "bulletinToken") {
              kinds.push(String(node.attrs["kind"]));
            }

            return true;
          });

          return document;
        },
      },
    );

    expect(kinds).toEqual(["mention", "emoticon", "spoiler"]);
    expect(output).toContain("@[Regular Member One](member:42)");
    expect(output).toContain(":smile:");
    expect(output).toContain("||secret||");
  });

  test("keeps custom nodes intact when text is typed around them", async () => {
    const output = await roundTripMarkdown("Hello @[Regular Member One](member:42) and :smile:.", {
      emoticons: EMOTICONS,
      edit: (document, schema) => editParagraph(document, schema, "Before", "after"),
    });

    expect(output).toContain("Before");
    expect(output).toContain("Hello @[Regular Member One](member:42)");
    expect(output).toContain(":smile:");
    expect(output).toContain("after");
  });

  test("leaves unknown emoticon codes as text", async () => {
    const output = await roundTripMarkdown("an :unknown: code", { emoticons: EMOTICONS });

    expect(output).toBe("an :unknown: code\n");
  });

  test("an untouched document saves its exact original markdown", () => {
    const unknown = ":::disabled-plugin\nraw syntax [b]hi[/b]\n:::";

    expect(markdownForSave(unknown, "canonical rewrite", false)).toBe(unknown);
    expect(markdownForSave(unknown, "canonical rewrite", true)).toBe("canonical rewrite");
  });
});
