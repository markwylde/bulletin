import type { Link, Paragraph, Parent, Root, Text } from "mdast";
import { visit } from "unist-util-visit";
import { type EmbedProvider, matchEmbedProvider } from "../embeds.ts";
import { unfurlPlaceholder } from "../unfurls.ts";

interface CustomNode extends Parent {
  readonly type: string;
  data?: Record<string, unknown>;
}

function isWhitespace(value: string): boolean {
  return value.trim().length === 0;
}

function text(value: string): Text {
  return { type: "text", value };
}

function standaloneLink(paragraph: Paragraph): Link | null {
  const meaningful = paragraph.children.filter(
    (child) => child.type !== "text" || !isWhitespace(child.value),
  );

  return meaningful.length === 1 && meaningful[0]?.type === "link" ? (meaningful[0] as Link) : null;
}

function embedPlaceholder(provider: EmbedProvider, id: string): CustomNode {
  return {
    type: "embedPlaceholder",
    children: [],
    data: {
      hName: "bl-embed",
      hProperties: { dataProvider: provider.key, dataEmbedId: id },
    },
  };
}

function unfurlNode(url: string, urlHash: string): CustomNode {
  return {
    type: "unfurlPlaceholder",
    children: [text(url)],
    data: {
      hName: "bl-unfurl",
      hProperties: { dataUrl: url, dataUrlHash: urlHash },
    },
  };
}

export interface LinkExtensionOptions {
  readonly embeds?: readonly EmbedProvider[];
  /** Adds a preview card placeholder for standalone public links (ADR 0007). */
  readonly unfurls?: boolean;
}

/**
 * Turns a paragraph containing only a link into an embed placeholder (allowlisted provider)
 * or an unfurl placeholder. Enabling unfurls is gated by the `unfurls` feature flag.
 */
export function applyLinkExtensions(tree: Root, options: LinkExtensionOptions = {}): void {
  const providers = options.embeds ?? [];

  visit(tree, "paragraph", (node, index, parent) => {
    if (parent === undefined || index === undefined) {
      return;
    }

    const link = standaloneLink(node);

    if (link === null) {
      return;
    }

    const embed = matchEmbedProvider(link.url, providers);

    if (embed !== null) {
      parent.children.splice(index, 1, embedPlaceholder(embed.provider, embed.id) as never);
      return;
    }

    if (options.unfurls !== true) {
      return;
    }

    const placeholder = unfurlPlaceholder(link.url);

    if (placeholder !== null) {
      parent.children.splice(index, 1, unfurlNode(placeholder.url, placeholder.urlHash) as never);
    }
  });
}
