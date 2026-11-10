import type { Root } from "hast";
import rehypeParse from "rehype-parse";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import { addLinkRel } from "./links.ts";
import { transformReplaceWords } from "./replace-words.ts";
import { profileSchema } from "./schema.ts";
import { toPlainText } from "./text.ts";
import type { ContentProfile, ReplaceWords } from "./types.ts";

export interface RefreshOptions {
  readonly profile: ContentProfile;
  readonly replaceWords?: ReplaceWords;
}

/**
 * Re-applies the current replace-word list to already-rendered HTML. Used on cache misses
 * for rows whose `render_version` predates the filter list (ADR 0007); `body_md` is untouched.
 */
export async function applyReplaceWordsToHtml(
  html: string,
  replaceWords?: ReplaceWords,
): Promise<string> {
  if (replaceWords === undefined || replaceWords.rules.length === 0) {
    return html;
  }

  return unified()
    .use(rehypeParse, { fragment: true })
    .use(() => (tree: Root) => {
      transformReplaceWords(tree, replaceWords);
    })
    .use(rehypeStringify)
    .process(html)
    .then((file) => String(file));
}

export interface RefreshedContent {
  readonly bodyHtml: string;
  readonly bodyText: string;
}

/**
 * The read path for stale rows: re-sanitise the stored HTML with the current rules and the
 * current replace list before caching. Never parses markdown (ADR 0007).
 */
export async function refreshStoredHtml(
  html: string,
  options: RefreshOptions,
): Promise<RefreshedContent> {
  let settled: Root | undefined;
  const processor = unified()
    .use(rehypeParse, { fragment: true })
    .use(() => (tree: Root) => {
      transformReplaceWords(tree, options.replaceWords);
    })
    .use(rehypeSanitize, profileSchema(options.profile))
    .use(() => (tree: Root) => {
      settled = tree;
      addLinkRel(tree);
    })
    .use(rehypeStringify);

  const bodyHtml = String(await processor.process(html));

  return { bodyHtml, bodyText: settled === undefined ? "" : toPlainText(settled) };
}
