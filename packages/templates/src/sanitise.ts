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

function attributeName(attribute: Element["attrs"][number]): string {
  return attribute.prefix === undefined
    ? attribute.name.toLowerCase()
    : `${attribute.prefix}:${attribute.name}`.toLowerCase();
}

function childrenOf(node: ParentNode): ChildNode[] {
  return "content" in node ? node.content.childNodes : node.childNodes;
}

function inspectElement(element: Element, removed: string[]): boolean {
  const tag = element.tagName.toLowerCase();

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

function walk(parent: ParentNode, removed: string[]): void {
  const children = childrenOf(parent);

  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];

    if (child === undefined || !("tagName" in child)) {
      continue;
    }

    if (!inspectElement(child, removed)) {
      children.splice(index, 1);
      continue;
    }

    if ("childNodes" in child || "content" in child) {
      walk(child as ParentNode, removed);
    }
  }
}

/**
 * Re-sanitises a fully rendered theme fragment (ADR 0008). Save-time validation sees only the
 * template's static markup; a Liquid expression can still assemble an off-origin form action,
 * an event handler or a `javascript:` URL, so every fragment build strips the same profile
 * before it is cached. Trusted HTML cannot be produced by an expression alone: a `SafeHtml`
 * view-model field that smuggles markup is sanitised here too.
 */
export function sanitiseRenderedMarkup(html: string): SanitisedMarkup {
  const fragment = parseFragment(html, {
    sourceCodeLocationInfo: false,
    // `noscript` is removed as an element, so a browser parsing its content as raw text and
    // this parser reading it as markup reach the same safe output.
    scriptingEnabled: false,
  });
  const removed: string[] = [];

  walk(fragment, removed);

  return {
    html: removed.length === 0 ? html : serialize(fragment),
    removed,
  };
}
