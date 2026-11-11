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
  attach: "Attach files",
  attachHint: "Drop files here or paste an image.",
  uploading: "Uploading…",
  processing: "Processing…",
  uploadReady: "Attached",
  uploadFailed: "Upload failed. Try again.",
  uploadQuota: "There is not enough storage space left.",
  uploadTooLarge: "That file is too large.",
  uploadType: "That file type is not allowed.",
  uploadRejected: "That file could not be accepted.",
};

describe("Editor server markup", () => {
  test("hides the mention control when the mentions flag is off", () => {
    const props = {
      contextKey: "reply:topic:1",
      initialMarkdown: "",
      forumId: "1",
      canUpload: true,
      emoticons: [],
      labels,
    };
    const off = renderToStaticMarkup(
      <Editor {...props} flags={{ mentions: false, attachments: true }} />,
    );
    const on = renderToStaticMarkup(
      <Editor {...props} flags={{ mentions: true, attachments: true }} />,
    );

    expect(off).not.toContain('aria-label="Mention a member"');
    expect(on).toContain('aria-label="Mention a member"');
  });

  test("renders a usable source editor and the translated toolbar", () => {
    const html = renderToStaticMarkup(
      <Editor
        contextKey="reply:topic:1"
        initialMarkdown="Hello **world**"
        forumId="1"
        canUpload
        emoticons={[{ code: "smile", src: "/files/smile.svg", alt: "Smile" }]}
        labels={labels}
        flags={{ mentions: true, attachments: true }}
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

describe("Editor attachment controls", () => {
  test("shows the attach control only when the viewer may upload", () => {
    const common = {
      contextKey: "reply:topic:1",
      initialMarkdown: "",
      forumId: "1",
      emoticons: [],
      labels,
      flags: { mentions: true, attachments: true },
    } as const;
    const allowed = renderToStaticMarkup(<Editor {...common} canUpload />);
    const denied = renderToStaticMarkup(<Editor {...common} canUpload={false} />);
    const flagOff = renderToStaticMarkup(
      <Editor {...common} canUpload flags={{ mentions: true, attachments: false }} />,
    );

    expect(allowed).toContain("data-editor-attach");
    expect(allowed).toContain("data-editor-file-input");
    expect(allowed).toContain("Drop files here or paste an image.");
    expect(denied).not.toContain("data-editor-attach");
    expect(denied).not.toContain("data-editor-file-input");
    expect(flagOff).not.toContain("data-editor-attach");
    expect(flagOff).toContain('data-editor-can-upload="false"');
  });
});
