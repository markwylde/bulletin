import { defaultValueCtx, Editor, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import {
  commonmark,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
} from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { callCommand, getMarkdown, insert, replaceAll } from "@milkdown/kit/utils";
import type { EditorController } from "./types.ts";

export interface CreateEditorOptions {
  readonly element: HTMLElement;
  readonly markdown: string;
  readonly label: string;
  readonly onChange: (markdown: string) => void;
}

/** Loads Milkdown lazily so the source-mode editor works without the WYSIWYG chunk. */
export async function createMilkdownEditor(
  options: CreateEditorOptions,
): Promise<EditorController> {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, options.element);
      ctx.set(defaultValueCtx, options.markdown);
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => options.onChange(markdown));
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .create();

  const view = () => editor.ctx.get(editorViewCtx);
  const dom = view().dom;
  dom.setAttribute("aria-label", options.label);
  dom.setAttribute("aria-multiline", "true");
  dom.setAttribute("role", "textbox");

  return {
    getMarkdown: () => editor.action(getMarkdown()),
    replaceAll: (markdown) => {
      editor.action(replaceAll(markdown));
    },
    insertText: (text) => {
      editor.action((ctx) => {
        const current = ctx.get(editorViewCtx);
        const { from, to } = current.state.selection;
        current.dispatch(current.state.tr.insertText(text, from, to));
        current.focus();
      });
    },
    insertMarkdown: (markdown) => {
      editor.action(insert(markdown, true));
    },
    replaceTextBeforeCursor: (length, text) => {
      editor.action((ctx) => {
        const current = ctx.get(editorViewCtx);
        const { from, to } = current.state.selection;
        current.dispatch(current.state.tr.insertText(text, Math.max(0, from - length), to));
        current.focus();
      });
    },
    format: (command) => {
      switch (command) {
        case "bold":
          editor.action(callCommand(toggleStrongCommand.key));
          break;
        case "italic":
          editor.action(callCommand(toggleEmphasisCommand.key));
          break;
        case "heading":
          editor.action(callCommand(wrapInHeadingCommand.key, 2));
          break;
        case "code":
          editor.action(callCommand(toggleInlineCodeCommand.key));
          break;
        case "quote":
          editor.action(callCommand(wrapInBlockquoteCommand.key));
          break;
        case "list":
          editor.action(callCommand(wrapInBulletListCommand.key));
          break;
      }

      view().focus();
    },
    destroy: () => {
      void editor.destroy();
    },
  };
}
