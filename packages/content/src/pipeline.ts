import type { Root as HastRoot } from "hast";
import type { Root as MdastRoot, Parent } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type Plugin, unified } from "unified";
import { visit } from "unist-util-visit";
import {
  type BeforeSaveStage,
  createBeforeSaveRegistry,
  defaultBeforeSaveStages,
  type SaveCheckContext,
} from "./before-save.ts";
import { expandEmbedPlaceholders } from "./embeds.ts";
import { applyAttachmentLinks } from "./extensions/attachments.ts";
import { applyInlineExtensions } from "./extensions/inline.ts";
import { applyLinkExtensions } from "./extensions/links.ts";
import { applyQuoteDirectives, type QuoteDirectiveResult } from "./extensions/quotes.ts";
import { addLinkRel } from "./links.ts";
import { renderVersionFor, SANITISER_VERSION, transformReplaceWords } from "./replace-words.ts";
import { profileSchema } from "./schema.ts";
import { toPlainText } from "./text.ts";
import {
  ContentError,
  type ContentProfile,
  type EmbedProvider,
  type Emoticon,
  type MentionResolver,
  type QuotePipeline,
  type QuoteSource,
  type RenderResult,
  type ReplaceWords,
  type SourceContext,
} from "./types.ts";

// The plugin's declaration chain references lib.dom, which would leak a partial DOM lib into
// every server consumer. A non-literal dynamic import keeps its types out of our program.
const HIGHLIGHT_MODULE = "rehype-highlight";
const rehypeHighlight = (await import(HIGHLIGHT_MODULE)).default as Plugin<
  [{ readonly detect?: boolean; readonly ignoreMissing?: boolean }?]
>;

export interface RenderContentOptions {
  readonly profile: ContentProfile;
  readonly context: SourceContext;
  readonly authorId: string;
  readonly emoticons?: readonly Emoticon[];
  readonly mentions?: MentionResolver;
  readonly embeds?: readonly EmbedProvider[];
  /** Adds unfurl card placeholders for standalone links (the `unfurls` flag). */
  readonly unfurls?: boolean;
  readonly quotes?: QuotePipeline;
  readonly replaceWords?: ReplaceWords;
}

function downgradeHeadings(parent: Parent): void {
  parent.children = parent.children.map((child) => {
    if (child.type !== "heading") {
      return child;
    }

    return {
      type: "paragraph",
      data: { hName: "p" },
      children: [{ type: "strong", children: child.children }],
    } as unknown as Parent["children"][number];
  }) as Parent["children"];

  for (const child of parent.children) {
    if (typeof child === "object" && child !== null && Array.isArray((child as Parent).children)) {
      downgradeHeadings(child as Parent);
    }
  }
}

function expandQuotePlaceholders(
  tree: HastRoot,
  placeholders: readonly {
    readonly token: string;
    readonly kind: string;
    readonly id: string;
    readonly snapshotId: string;
  }[],
): void {
  if (placeholders.length === 0) {
    return;
  }

  const byToken = new Map(placeholders.map((placeholder) => [placeholder.token, placeholder]));

  visit(tree, "text", (node, index, parent) => {
    const placeholder = byToken.get(node.value.trim());

    if (placeholder === undefined || parent === undefined || index === undefined) {
      return;
    }

    parent.children.splice(index, 1, {
      type: "element",
      tagName: "bl-quote",
      properties: {
        dataSourceKind: placeholder.kind,
        dataSource: placeholder.id,
        dataSnapshot: placeholder.snapshotId,
      },
      children: [],
    });
  });
}

function processorFor(
  options: RenderContentOptions,
  placeholders: () => readonly {
    readonly token: string;
    readonly kind: string;
    readonly id: string;
    readonly snapshotId: string;
  }[],
) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(() => (tree: HastRoot) => {
      transformReplaceWords(tree, options.replaceWords);
    })
    .use(rehypeSanitize, profileSchema(options.profile))
    .use(() => (tree: HastRoot) => {
      expandQuotePlaceholders(tree, placeholders());
      expandEmbedPlaceholders(tree, options.embeds ?? []);
    })
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
    .use(() => (tree: HastRoot) => {
      addLinkRel(tree);
    })
    .use(rehypeStringify);
}

function snapshotPipeline(
  options: RenderContentOptions,
  quotes: QuotePipeline,
): (source: QuoteSource) => Promise<string> {
  const pending = new Map<string, Promise<string>>();

  return (source) => {
    const key = `${source.ref.kind}:${source.ref.id}`;
    const existing = pending.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const created = (async () => {
      const { quotes: _ignored, ...rest } = options;
      const rendered = await renderMarkdown(source.bodyMd, rest, true);

      return quotes.snapshots.create({
        sourceKind: source.ref.kind,
        sourceId: source.ref.id,
        sourceAuthorId: source.sourceAuthorId,
        bodyMd: source.bodyMd,
        bodyHtml: rendered.bodyHtml,
        renderVersion: rendered.renderVersion,
        sanitiserVersion: rendered.sanitiserVersion,
      });
    })();

    pending.set(key, created);
    return created;
  };
}

async function renderMarkdown(
  bodyMd: string,
  options: RenderContentOptions,
  snapshot: boolean,
): Promise<Omit<RenderResult, "bodyMd">> {
  let quotePlaceholders: readonly {
    readonly token: string;
    readonly kind: string;
    readonly id: string;
    readonly snapshotId: string;
  }[] = [];
  const processor = processorFor(options, () => quotePlaceholders);
  const tree = processor.parse(bodyMd) as MdastRoot;

  if (options.profile === "signature") {
    downgradeHeadings(tree);
  }

  const inline = await applyInlineExtensions(tree, {
    ...(options.emoticons === undefined ? {} : { emoticons: options.emoticons }),
    ...(options.mentions === undefined ? {} : { mentions: options.mentions }),
  });

  if (options.profile === "post" || options.profile === "rules") {
    applyAttachmentLinks(tree);
    applyLinkExtensions(tree, {
      ...(options.embeds === undefined ? {} : { embeds: options.embeds }),
      ...(options.unfurls === undefined ? {} : { unfurls: options.unfurls }),
    });
  }

  let quotes: QuoteDirectiveResult = { quoteSources: [], quotedForumIds: [], placeholders: [] };

  if (snapshot || options.quotes === undefined) {
    quotes = await applyQuoteDirectives(tree, {
      context: options.context,
      authorId: options.authorId,
      resolver: {
        canRead: async () => false,
        load: async () => null,
      },
      createSnapshot: async () => {
        throw new ContentError("quote_unreadable", "Quotes cannot be nested inside a snapshot");
      },
      strip: true,
    });
  } else {
    quotes = await applyQuoteDirectives(tree, {
      context: options.context,
      authorId: options.authorId,
      resolver: options.quotes.resolver,
      createSnapshot: snapshotPipeline(options, options.quotes),
    });
  }

  quotePlaceholders = quotes.placeholders;
  const hast = (await processor.run(tree)) as HastRoot;

  return {
    bodyHtml: processor.stringify(hast),
    bodyText: toPlainText(hast),
    renderVersion: renderVersionFor(options.replaceWords),
    sanitiserVersion: SANITISER_VERSION,
    mentionedMemberIds: inline.mentionedMemberIds,
    quotedForumIds: quotes.quotedForumIds,
    quoteSources: quotes.quoteSources,
  };
}

/**
 * Renders markdown exactly once at write time (ADR 0007). The stored markdown is returned
 * unchanged; HTML and quote-free plain text are derived values.
 */
export async function renderContent(
  bodyMd: string,
  options: RenderContentOptions,
): Promise<RenderResult> {
  return { bodyMd, ...(await renderMarkdown(bodyMd, options, false)) };
}

/** Renders a quote snapshot; nested quotes are dropped rather than resolved recursively. */
export async function renderSnapshot(
  bodyMd: string,
  options: Omit<RenderContentOptions, "quotes">,
): Promise<Omit<RenderResult, "bodyMd">> {
  return renderMarkdown(bodyMd, options, true);
}

export interface SaveContentOptions extends RenderContentOptions {
  readonly stages?: readonly BeforeSaveStage[];
  readonly checks?: Omit<SaveCheckContext, "profile" | "context" | "authorId">;
}

/**
 * The write pipeline: `beforeSave` (transform/checks/vetoes), then parse, sanitise, render.
 * `bodyMd` in the result is the transformed markdown that is actually stored.
 */
export async function saveContent(
  bodyMd: string,
  options: SaveContentOptions,
): Promise<RenderResult> {
  const { stages, checks, ...renderOptions } = options;
  const registry = createBeforeSaveRegistry([...defaultBeforeSaveStages(), ...(stages ?? [])]);
  const checked = await registry.run(bodyMd, {
    profile: options.profile,
    context: options.context,
    authorId: options.authorId,
    ...(checks?.blockedWords === undefined ? {} : { blockedWords: checks.blockedWords }),
    ...(checks?.blockedAnyWords === undefined ? {} : { blockedAnyWords: checks.blockedAnyWords }),
    ...(checks?.maxLinks === undefined ? {} : { maxLinks: checks.maxLinks }),
  });

  return renderContent(checked, renderOptions);
}
