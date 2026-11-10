export interface EditorEmoticon {
  readonly code: string;
  readonly src: string;
  readonly alt: string;
}

/** Every editor string comes from the template's translated labels (ADR 0013). */
export interface EditorLabels {
  readonly editor: string;
  readonly toolbar: string;
  readonly wysiwyg: string;
  readonly source: string;
  readonly bold: string;
  readonly italic: string;
  readonly heading: string;
  readonly link: string;
  readonly code: string;
  readonly quote: string;
  readonly spoiler: string;
  readonly list: string;
  readonly emoticon: string;
  readonly mention: string;
  readonly draftFound: string;
  readonly restoreDraft: string;
  readonly discardDraft: string;
  readonly saving: string;
  readonly saved: string;
  readonly saveFailed: string;
  readonly mentionEmpty: string;
  readonly mentionLoading: string;
}

export interface EditorProps {
  readonly contextKey: string;
  readonly initialMarkdown: string;
  readonly emoticons: readonly EditorEmoticon[];
  readonly labels: EditorLabels;
}

export type EditorMode = "wysiwyg" | "source";

export interface EditorController {
  getMarkdown(): string;
  replaceAll(markdown: string): void;
  insertText(text: string): void;
  insertMarkdown(markdown: string): void;
  replaceTextBeforeCursor(length: number, text: string): void;
  format(command: EditorCommand): void;
  destroy(): void;
}

export type EditorCommand = "bold" | "italic" | "heading" | "code" | "quote" | "list";
