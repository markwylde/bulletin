import { type DefaultTreeAdapterTypes, parseFragment, serialize } from "parse5";
import {
  BANNED_ELEMENTS,
  isForbiddenUrlAttribute,
  isSameOriginTarget,
  URL_ATTRIBUTES,
} from "./markup-policy.ts";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode | DefaultTreeAdapterTypes.Template;

export interface SanitisedMarkup {
  readonly html: string;
  /** What was removed or neutered, for the admin-facing violation report. */
  readonly removed: readonly string[];
}

export interface SanitiseRenderedMarkupOptions {
  /**
   * Exact `https` origins of allowlisted embed providers (ADR 0007, 0008). An iframe is kept
   * only when the content pipeline marked it (`data-bl-embed`) and its `src` is on one of
   * these origins; theme-authored frames never carry the marker.
   */
  readonly trustedFrameOrigins?: readonly string[];
}

/** Attributes a content-pipeline player may keep after theme sanitising. */
const EMBED_FRAME_ATTRIBUTES: ReadonlySet<string> = new Set([
  "src",
  "title",
  "loading",
  "allow",
  "allowfullscreen",
  "referrerpolicy",
  "width",
  "height",
  "class",
  "data-bl-embed",
]);

function attributeName(attribute: Element["attrs"][number]): string {
  return attribute.prefix === undefined
    ? attribute.name.toLowerCase()
    : `${attribute.prefix}:${attribute.name}`.toLowerCase();
}

function trustedEmbedOrigin(
  element: Element,
  trustedFrameOrigins: readonly string[],
): string | null {
  const marker = element.attrs.find((attribute) => attributeName(attribute) === "data-bl-embed");
  const src = element.attrs.find((attribute) => attributeName(attribute) === "src")?.value;

  if (marker === undefined || marker.value === "" || src === undefined) {
    return null;
  }

  try {
    const url = new URL(src);
    return url.protocol === "https:" && trustedFrameOrigins.includes(url.origin)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function childrenOf(node: ParentNode): ChildNode[] {
  return "content" in node ? node.content.childNodes : node.childNodes;
}

function inspectElement(
  element: Element,
  removed: string[],
  trustedFrameOrigins: readonly string[],
): boolean {
  const tag = element.tagName.toLowerCase();

  if (tag === "iframe") {
    if (trustedEmbedOrigin(element, trustedFrameOrigins) === null) {
      removed.push("the iframe element");
      return false;
    }

    // Only the generated player shape survives; `srcdoc` and any other attribute a theme
    // could use to put different content inside an allowlisted frame are dropped.
    element.attrs = element.attrs.filter((attribute) => {
      const name = attributeName(attribute);

      if (EMBED_FRAME_ATTRIBUTES.has(name)) {
        return true;
      }

      removed.push(`the ${name} attribute on iframe`);
      return false;
    });

    return true;
  }

  if (BANNED_ELEMENTS[tag] === true) {
    removed.push(`the ${tag} element`);
    return false;
  }

  if (tag === "meta") {
    const httpEquiv = element.attrs.find((attribute) => attribute.name === "http-equiv");

    if (httpEquiv?.value.trim().toLowerCase() === "refresh") {
      removed.push("the http-equiv refresh meta tag");
      return false;
    }
  }

  const attrs: Element["attrs"] = [];

  for (const attribute of element.attrs) {
    const name = attributeName(attribute);

    if (/^on[a-z]/.test(name)) {
      removed.push(`the ${name} attribute on ${tag}`);
      continue;
    }

    if (URL_ATTRIBUTES.has(name) && isForbiddenUrlAttribute(name, attribute.value)) {
      removed.push(`the ${name} attribute on ${tag}`);
      continue;
    }

    if ((name === "action" || name === "formaction") && !isSameOriginTarget(attribute.value)) {
      removed.push(`the ${name} attribute on ${tag}`);
      continue;
    }

    attrs.push(attribute);
  }

  element.attrs = attrs;
  return true;
}

function walk(parent: ParentNode, removed: string[], trustedFrameOrigins: readonly string[]): void {
  const children = childrenOf(parent);

  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];

    if (child === undefined || !("tagName" in child)) {
      continue;
    }

    if (!inspectElement(child, removed, trustedFrameOrigins)) {
      children.splice(index, 1);
      continue;
    }

    if ("childNodes" in child || "content" in child) {
      walk(child as ParentNode, removed, trustedFrameOrigins);
    }
  }
}

/**
 * Re-sanitises a fully rendered theme fragment (ADR 0008). Save-time validation sees only the
 * template's static markup; a Liquid expression can still assemble an off-origin form action,
 * an event handler or a `javascript:` URL, so every fragment build strips the same profile
 * before it is cached. Trusted HTML cannot be produced by an expression alone: a `SafeHtml`
 * view-model field that smuggles markup is sanitised here too.
 *
 * Content-pipeline embeds are the one exception: they are marked by the pipeline and must
 * point at an allowlisted provider origin, so a theme still cannot create an arbitrary
 * frame (ADR 0007).
 */
export function sanitiseRenderedMarkup(
  html: string,
  options: SanitiseRenderedMarkupOptions = {},
): SanitisedMarkup {
  const trustedFrameOrigins = options.trustedFrameOrigins ?? [];
  const fragment = parseFragment(html, {
    sourceCodeLocationInfo: false,
    // `noscript` is removed as an element, so a browser parsing its content as raw text and
    // this parser reading it as markup reach the same safe output.
    scriptingEnabled: false,
  });
  const removed: string[] = [];

  walk(fragment, removed, trustedFrameOrigins);

  return {
    html: removed.length === 0 ? html : serialize(fragment),
    removed,
  };
}
