import type { Element, Root } from "hast";
import rehypeParse from "rehype-parse";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import {
  collapseEmbedPlaceholders,
  type EmbedProvider,
  expandEmbedPlaceholders,
} from "./embeds.ts";
import { addLinkRel } from "./links.ts";
import { transformReplaceWords } from "./replace-words.ts";
import { profileSchema } from "./schema.ts";
import { toPlainText } from "./text.ts";
import type { ContentProfile, ReplaceWords } from "./types.ts";

export interface RefreshOptions {
  readonly profile: ContentProfile;
  readonly replaceWords?: ReplaceWords;
  /** Provider allowlist used to rebuild stored players during a re-render (ADR 0007). */
  readonly embedProviders?: readonly EmbedProvider[];
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
 *
 * Stored HTML also carries the pipeline's derived nodes — quote placeholders and player
 * wrappers — so a refresh keeps validated quotes and rebuilds embeds from the provider
 * allowlist instead of discarding them with the untrusted input schema.
 */
export async function refreshStoredHtml(
  html: string,
  options: RefreshOptions,
): Promise<RefreshedContent> {
  const embedProviders = options.embedProviders ?? [];
  let settled: Root | undefined;
  const processor = unified()
    .use(rehypeParse, { fragment: true })
    .use(() => (tree: Root) => {
      transformReplaceWords(tree, options.replaceWords);
      collapseEmbedPlaceholders(tree, embedProviders);
      pruneInvalidQuotes(tree);
    })
    .use(rehypeSanitize, refreshSchema(options.profile))
    .use(() => (tree: Root) => {
      expandEmbedPlaceholders(tree, embedProviders);
      settled = tree;
      addLinkRel(tree);
    })
    .use(rehypeStringify);

  const bodyHtml = String(await processor.process(html));

  return { bodyHtml, bodyText: settled === undefined ? "" : toPlainText(settled) };
}

/**
 * The input profile plus the pipeline's own quote placeholder. Player markup is deliberately
 * absent: embeds are rebuilt from `bl-embed` after sanitising, like the write path does.
 */
function refreshSchema(profile: ContentProfile) {
  const base = profileSchema(profile);

  return {
    ...base,
    tagNames: [...(base.tagNames ?? []), "bl-quote"],
    attributes: {
      ...base.attributes,
      "bl-quote": ["dataSourceKind", "dataSource", "dataSnapshot"],
    },
  };
}

/** A quote reference is only kept when it is one the write pipeline could have produced. */
function isValidQuote(node: Element): boolean {
  const kind = node.properties.dataSourceKind;
  const source = node.properties.dataSource;
  const snapshot = node.properties.dataSnapshot;

  return (
    (kind === "post" || kind === "message") &&
    typeof source === "string" &&
    /^\d+$/.test(source) &&
    typeof snapshot === "string" &&
    /^\d+$/.test(snapshot)
  );
}

function pruneInvalidQuotes(tree: Root): void {
  visit(tree, "element", (node, index, parent) => {
    if (node.tagName !== "bl-quote" || parent === undefined || index === undefined) {
      return;
    }

    if (isValidQuote(node)) {
      return;
    }

    parent.children.splice(index, 1);
    // Continue with the sibling that moved into this slot.
    return [SKIP, index];
  });
}
