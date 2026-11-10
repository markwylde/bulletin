import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Editor } from "./Editor.tsx";
import type { EditorLabels } from "./editor/types.ts";

const labels: EditorLabels = {
  editor: "Message editor",
  toolbar: "Formatting",
  wysiwyg: "WYSIWYG",
  source: "Source",
  bold: "Bold",
  italic: "Italic",
  heading: "Heading",
  link: "Link",
  code: "Code",
  quote: "Quote",
  spoiler: "Spoiler",
  list: "Bullet list",
  emoticon: "Emoticons",
  mention: "Mention a member",
  draftFound: "A saved draft was found.",
  restoreDraft: "Restore draft",
  discardDraft: "Discard draft",
  saving: "Saving draft…",
  saved: "Draft saved",
  saveFailed: "Could not save the draft.",
  mentionEmpty: "No members found.",
  mentionLoading: "Searching members…",
};

describe("Editor server markup", () => {
  test("renders a usable source editor and the translated toolbar", () => {
    const html = renderToStaticMarkup(
      <Editor
        contextKey="reply:topic:1"
        initialMarkdown="Hello **world**"
        emoticons={[{ code: "smile", src: "/files/smile.svg", alt: "Smile" }]}
        labels={labels}
      />,
    );

    expect(html).toContain('data-editor="true"');
    expect(html).toContain('data-draft-context="reply:topic:1"');
    expect(html).toContain('data-editor-toolbar="true"');
    expect(html).toContain('data-editor-source="true"');
    expect(html).toContain("Hello **world**");
    expect(html).toContain('aria-label="Message editor"');
    expect(html).toContain('aria-label="Bold"');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-live="polite"');
  });
});
