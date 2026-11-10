import { visit } from "unist-util-visit";

import type { EmbedMatch, EmbedProvider } from "./types.ts";

export type { EmbedMatch, EmbedProvider } from "./types.ts";

const EMBED_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Matches a standalone URL against the enabled provider allowlist. */
export function matchEmbedProvider(
  input: string,
  providers: readonly EmbedProvider[],
): EmbedMatch | null {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }

  for (const provider of providers) {
    let pattern: RegExp;

    try {
      pattern = new RegExp(provider.urlPattern, "i");
    } catch {
      continue;
    }

    const match = pattern.exec(url.toString());
    const id = match?.[1];

    if (id === undefined || !EMBED_ID.test(id)) {
      continue;
    }

    const embedUrl = provider.embedUrl.replaceAll("{id}", id);
    const parsed = new URL(embedUrl);

    if (parsed.protocol !== "https:") {
      continue;
    }

    return { provider, id, url: url.toString(), embedUrl: parsed.toString() };
  }

  return null;
}

/** The safe subset of provider data used to build the iframe. */
export function embedIframeSrc(provider: EmbedProvider, id: string): string | null {
  if (!EMBED_ID.test(id)) {
    return null;
  }

  try {
    const url = new URL(provider.embedUrl.replaceAll("{id}", id));
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export const DEFAULT_EMBED_PROVIDERS: readonly EmbedProvider[] = [
  {
    key: "youtube",
    title: "YouTube",
    urlPattern:
      "^https?://(?:www\\.)?(?:youtube\\.com/(?:watch\\?v=|shorts/)|youtu\\.be/)([A-Za-z0-9_-]{6,64})(?:[?&#/].*)?$",
    embedUrl: "https://www.youtube-nocookie.com/embed/{id}",
  },
  {
    key: "vimeo",
    title: "Vimeo",
    urlPattern: "^https?://(?:www\\.)?vimeo\\.com/(\\d{3,12})(?:[/?#].*)?$",
    embedUrl: "https://player.vimeo.com/video/{id}",
  },
];

export interface EmbedPlaceholderOptions {
  readonly providers: readonly EmbedProvider[];
}

function isEmbedPlaceholder(node: { type: string; tagName?: string }): boolean {
  return node.type === "element" && node.tagName === "bl-embed";
}

/**
 * Replaces trusted `<bl-embed>` placeholders with the player wrapper. Runs after sanitising,
 * so the iframe markup itself is never accepted from member content (ADR 0007).
 */
export function expandEmbedPlaceholders(
  tree: import("hast").Root,
  providers: readonly EmbedProvider[],
): void {
  const byKey = new Map(providers.map((provider) => [provider.key, provider]));

  visit(tree, "element", (node, index, parent) => {
    if (!isEmbedPlaceholder(node) || parent === undefined || index === undefined) {
      return;
    }

    const key = node.properties.dataProvider;
    const id = node.properties.dataEmbedId;
    const provider = typeof key === "string" ? byKey.get(key) : undefined;
    const src =
      provider === undefined || typeof id !== "string" ? null : embedIframeSrc(provider, id);

    if (provider === undefined || src === null) {
      parent.children.splice(index, 1);
      return;
    }

    parent.children.splice(index, 1, {
      type: "element",
      tagName: "div",
      properties: { className: ["embed", `embed-${provider.key}`] },
      children: [
        {
          type: "element",
          tagName: "iframe",
          properties: {
            src,
            title: provider.title,
            loading: "lazy",
            allowFullscreen: true,
            allow:
              "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
            referrerPolicy: "strict-origin-when-cross-origin",
          },
          children: [],
        },
      ],
    });
  });
}

export interface StoredEmbed {
  readonly provider: EmbedProvider;
  readonly id: string;
}

/**
 * Recovers the provider and id from an iframe URL this pipeline generated earlier. Only
 * URLs that one of the provider templates could have produced match, so a re-render can
 * rebuild the wrapper from trusted provider data instead of keeping stored markup (ADR 0007).
 */
export function storedEmbedFromSrc(
  src: string,
  providers: readonly EmbedProvider[],
): StoredEmbed | null {
  let url: URL;

  try {
    url = new URL(src);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") {
    return null;
  }

  for (const provider of providers) {
    const [before = "", after = ""] = provider.embedUrl.split("{id}");
    const pattern = new RegExp(
      `^${escapeRegExp(before)}([A-Za-z0-9_-]{1,64})${escapeRegExp(after)}$`,
    );
    const id = pattern.exec(url.toString())?.[1];

    if (id !== undefined) {
      return { provider, id };
    }
  }

  return null;
}

/**
 * Rewrites stored player iframes back to `bl-embed` placeholders before sanitising, so the
 * re-render only ever trusts the provider allowlist (see `expandEmbedPlaceholders`). Iframes
 * no provider recognises are left in place for the sanitiser to drop.
 */
export function collapseEmbedPlaceholders(
  tree: import("hast").Root,
  providers: readonly EmbedProvider[],
): void {
  visit(tree, "element", (node, index, parent) => {
    if (node.tagName !== "iframe" || parent === undefined || index === undefined) {
      return;
    }

    const src = node.properties.src;
    const embed = typeof src === "string" ? storedEmbedFromSrc(src, providers) : null;

    if (embed === null) {
      return;
    }

    parent.children[index] = {
      type: "element",
      tagName: "bl-embed",
      properties: { dataProvider: embed.provider.key, dataEmbedId: embed.id },
      children: [],
    };
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
