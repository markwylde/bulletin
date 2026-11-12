import { describe, expect, test } from "bun:test";
import { renderSearchSnippet, SNIPPET_START, SNIPPET_STOP } from "./snippet.ts";

describe("search snippets", () => {
  test("keeps markup in the content literal and only highlights with mark", () => {
    const headline = `Use <b>${SNIPPET_START}bold${SNIPPET_STOP}</b> text & "quotes"`;

    const snippet = renderSearchSnippet(headline);

    expect(snippet).toBe("Use &lt;b&gt;<mark>bold</mark>&lt;/b&gt; text &amp; &quot;quotes&quot;");
    expect(snippet).not.toContain("<b>");
    expect(snippet.match(/<mark>/g)).toHaveLength(1);
  });

  test("does not let a stray sentinel inject anything but a mark", () => {
    const snippet = renderSearchSnippet(`a ${SNIPPET_START} <script>alert(1)</script>`);

    expect(snippet).toBe("a <mark> &lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
