import { listEditorEmoticons } from "@bulletin/domain/content";
import type { Translator } from "@bulletin/i18n";
import type { SQL } from "bun";

export interface EditorView {
  readonly name?: string;
  readonly contextKey: string;
  readonly initialMarkdown: string;
  readonly emoticons: readonly {
    readonly code: string;
    readonly src: string;
    readonly alt: string;
  }[];
  readonly labels: Readonly<Record<string, string>>;
  readonly flags: { readonly mentions: boolean };
}

/** Builds the translated Editor island props shared by the new-topic and reply forms. */
export async function buildEditorView(
  sql: SQL,
  translate: Translator,
  input: {
    readonly contextKey: string;
    readonly initialMarkdown?: string;
    readonly mentions: boolean;
    readonly name?: string;
  },
): Promise<EditorView> {
  const sets = await listEditorEmoticons(sql);

  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    contextKey: input.contextKey,
    initialMarkdown: input.initialMarkdown ?? "",
    emoticons: sets.flatMap((set) =>
      set.emoticons.map((emoticon) => ({
        code: emoticon.code,
        src: emoticon.src,
        alt: emoticon.alt,
      })),
    ),
    labels: {
      editor: translate("editor.label"),
      toolbar: translate("editor.toolbar"),
      wysiwyg: translate("editor.wysiwyg"),
      source: translate("editor.source"),
      bold: translate("editor.bold"),
      italic: translate("editor.italic"),
      heading: translate("editor.heading"),
      link: translate("editor.link"),
      code: translate("editor.code"),
      quote: translate("editor.quote"),
      spoiler: translate("editor.spoiler"),
      list: translate("editor.list"),
      emoticon: translate("editor.emoticon"),
      mention: translate("editor.mention"),
      draftFound: translate("editor.draft.found"),
      restoreDraft: translate("editor.draft.restore"),
      discardDraft: translate("editor.draft.discard"),
      saving: translate("editor.draft.saving"),
      saved: translate("editor.draft.saved"),
      saveFailed: translate("editor.draft.failed"),
      mentionEmpty: translate("editor.mention.empty"),
      mentionLoading: translate("editor.mention.loading"),
    },
    flags: { mentions: input.mentions },
  };
}
