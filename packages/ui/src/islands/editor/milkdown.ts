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
import { Fragment } from "@milkdown/kit/prose/model";
import { callCommand, getMarkdown, insert, replaceAll } from "@milkdown/kit/utils";
import { bulletinTokenPlugins } from "./plugins.ts";
import type { EditorController, EditorEmoticon } from "./types.ts";

const RAW_BLOCK = /^:::[a-z0-9-]+[^\n]*\n[\s\S]*?\n:::[ \t]*$/gim;

export interface PreprocessedMarkdown {
  readonly markdown: string;
  readonly raw: ReadonlyMap<string, string>;
}

/**
 * Unknown directive blocks are replaced with private HTML comments while WYSIWYG is active.
 * The comments round-trip through Milkdown's HTML node, then the original block is restored
 * on every read, so unrelated edits never rewrite unsupported syntax (ADR 0007).
 */
export function preprocessRawBlocks(markdown: string): PreprocessedMarkdown {
  const raw = new Map<string, string>();
  const next = markdown.replace(RAW_BLOCK, (block) => {
    const token = `⟦raw-block-${raw.size}⟧`;
    raw.set(token, block);
    return token;
  });

  return { markdown: next, raw };
}

export function restoreRawBlocks(markdown: string, raw: ReadonlyMap<string, string>): string {
  let next = markdown;

  for (const [token, block] of raw) {
    next = next.replaceAll(token, block);
  }

  return next;
}

export interface CreateEditorOptions {
  readonly element: HTMLElement;
  readonly markdown: string;
  readonly label: string;
  readonly emoticons: readonly EditorEmoticon[];
  readonly onChange: (markdown: string) => void;
}

/** Loads Milkdown lazily so the source-mode editor works without the WYSIWYG chunk. */
export async function createMilkdownEditor(
  options: CreateEditorOptions,
): Promise<EditorController> {
  const preprocessed = preprocessRawBlocks(options.markdown);
  const raw = new Map(preprocessed.raw);
  const tokenPlugins = bulletinTokenPlugins(options.emoticons);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, options.element);
      ctx.set(defaultValueCtx, preprocessed.markdown);
      ctx
        .get(listenerCtx)
        .markdownUpdated((_ctx, markdown) => options.onChange(restoreRawBlocks(markdown, raw)));
    })
    .use(commonmark)
    .use(gfm)
    .use(tokenPlugins)
    .use(listener)
    .create();

  const view = () => editor.ctx.get(editorViewCtx);
  const dom = view().dom;
  dom.setAttribute("aria-label", options.label);
  dom.setAttribute("aria-multiline", "true");
  dom.setAttribute("role", "textbox");

  return {
    getMarkdown: () => restoreRawBlocks(editor.action(getMarkdown()), raw),
    replaceAll: (markdown) => {
      const next = preprocessRawBlocks(markdown);
      raw.clear();

      for (const [token, block] of next.raw) {
        raw.set(token, block);
      }

      editor.action(replaceAll(next.markdown));
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
    insertMemberMention: (id, displayName) => {
      editor.action((ctx) => {
        const current = ctx.get(editorViewCtx);
        const { state } = current;
        const link = state.schema.marks.link?.create({ href: `member:${id}`, title: null });

        if (link === undefined) {
          return;
        }

        const fragment = Fragment.fromArray([
          state.schema.text("@"),
          state.schema.text(displayName, [link]),
        ]);
        const { from, to } = state.selection;
        current.dispatch(state.tr.replaceWith(from, to, fragment));
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
