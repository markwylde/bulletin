import {
  type DefaultTreeAdapterTypes,
  parse as parseDocument,
  parseFragment,
  serializeOuter,
} from "parse5";
import { maskLiquid } from "./validate.ts";

/**
 * The theme `head` template (change `seo-feeds`): themes control how page metadata is
 * presented, but the app owns the values that decide indexing. The template renders only
 * `<title>`, `<meta>` and `<link rel="canonical|alternate">`; the required-meta check then
 * guarantees one title, the trusted robots directive, the trusted canonical and the trusted
 * `hreflang` set, whatever the theme emitted. JSON-LD is not theme markup (themes cannot emit
 * scripts, ADR 0008); the layout adds it from the view model with the CSP nonce.
 */
export const HEAD_TEMPLATE_NAME = "head";

type Element = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

export interface HeadAlternate {
  readonly hreflang: string;
  readonly href: string;
}

/** The view model the `head` template receives as `seo` (absolute URLs). */
export interface ThemeHeadSeo {
  readonly title: string;
  readonly description: string;
  readonly canonical: string;
  readonly robots: string;
  /** OpenGraph type: `website`, `article` or `profile`. */
  readonly type: string;
  readonly locale: string;
  readonly alternates: readonly HeadAlternate[];
}

export interface ThemeHeadViewModel {
  readonly seo: ThemeHeadSeo;
  readonly boardName: string;
}

export interface EnforcedHead {
  readonly html: string;
  /** What the check removed or replaced, for the admin-facing violation report. */
  readonly problems: readonly string[];
}

const ALLOWED_LINK_RELS: ReadonlySet<string> = new Set(["canonical", "alternate"]);

function attribute(element: Element, name: string): string | null {
  return element.attrs.find((entry) => entry.name.toLowerCase() === name)?.value ?? null;
}

function relTokens(element: Element): readonly string[] {
  return (attribute(element, "rel") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== "");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

/** Why a top-level element may not stay in the head, or null when it may. */
function headElementProblem(element: Element): string | null {
  const tag = element.tagName.toLowerCase();

  if (tag === "title") {
    return null;
  }

  if (tag === "meta") {
    if (attribute(element, "http-equiv") !== null || attribute(element, "charset") !== null) {
      return "a meta http-equiv or charset tag";
    }

    if (attribute(element, "name") === null && attribute(element, "property") === null) {
      return "a meta tag without name or property";
    }

    return null;
  }

  if (tag === "link") {
    const rels = relTokens(element);

    return rels.length === 1 && ALLOWED_LINK_RELS.has(rels[0] ?? "")
      ? null
      : `a link with rel="${rels.join(" ")}"`;
  }

  return `the ${tag} element`;
}

/**
 * The required-meta check, applied to every rendered `head` template before it is served:
 * only allowed elements survive, robots/canonical/og:url/`hreflang` links that disagree with
 * the trusted values are dropped, and a missing title, robots, canonical or alternate is added
 * from the trusted view model. A broken or hostile theme therefore cannot make a private page
 * indexable, move its canonical or advertise foreign locale variants.
 */
export function enforceHeadMarkup(html: string, seo: ThemeHeadSeo): EnforcedHead {
  const fragment = parseFragment(html, { scriptingEnabled: false });
  const problems: string[] = [];
  const kept: string[] = [];
  const trustedAlternates = new Set(
    seo.alternates.map((alternate) => `${alternate.hreflang.toLowerCase()} ${alternate.href}`),
  );
  const emittedAlternates = new Set<string>();
  let title = false;
  let robots = false;
  let canonical = false;

  for (const node of fragment.childNodes) {
    if (!isElement(node)) {
      if (node.nodeName === "#text" && "value" in node && node.value.trim() !== "") {
        problems.push("text outside a head element");
      }

      continue;
    }

    const problem = headElementProblem(node);

    if (problem !== null) {
      problems.push(`removed ${problem}`);
      continue;
    }

    const tag = node.tagName.toLowerCase();
    const name = attribute(node, "name")?.toLowerCase() ?? null;
    const property = attribute(node, "property")?.toLowerCase() ?? null;
    const content = attribute(node, "content");

    if (tag === "title") {
      if (title) {
        problems.push("removed a duplicate title");
        continue;
      }

      title = true;
    } else if (tag === "meta" && name === "robots") {
      if (robots || content?.trim() !== seo.robots) {
        problems.push("replaced the robots directive");
        continue;
      }

      robots = true;
    } else if (tag === "meta" && property === "og:url" && content !== seo.canonical) {
      problems.push("removed an og:url that is not the canonical URL");
      continue;
    } else if (tag === "link" && relTokens(node)[0] === "canonical") {
      if (canonical || attribute(node, "href") !== seo.canonical) {
        problems.push("replaced the canonical link");
        continue;
      }

      canonical = true;
    } else if (tag === "link") {
      const key = `${attribute(node, "hreflang")?.toLowerCase() ?? ""} ${attribute(node, "href") ?? ""}`;

      if (!trustedAlternates.has(key) || emittedAlternates.has(key)) {
        problems.push("removed an alternate link that is not a locale variant");
        continue;
      }

      emittedAlternates.add(key);
    }

    kept.push(serializeOuter(node));
  }

  const additions: string[] = [];

  if (!title) {
    additions.push(`<title>${escapeText(seo.title)}</title>`);
  }

  if (!robots) {
    additions.push(`<meta name="robots" content="${escapeAttribute(seo.robots)}">`);
  }

  if (!canonical) {
    additions.push(`<link rel="canonical" href="${escapeAttribute(seo.canonical)}">`);
  }

  for (const alternate of seo.alternates) {
    if (!emittedAlternates.has(`${alternate.hreflang.toLowerCase()} ${alternate.href}`)) {
      additions.push(
        `<link rel="alternate" hreflang="${escapeAttribute(alternate.hreflang)}" href="${escapeAttribute(alternate.href)}">`,
      );
    }
  }

  if (!title || !robots || !canonical) {
    problems.push(
      `added missing ${[
        !title ? "title" : null,
        !robots ? "robots" : null,
        !canonical ? "canonical" : null,
      ]
        .filter((entry) => entry !== null)
        .join(", ")}`,
    );
  }

  return { html: [...kept, ...additions].join("\n"), problems };
}

export type HeadTemplateIssue =
  | { readonly code: "missing_meta"; readonly meta: "canonical" | "robots" | "title" }
  | { readonly code: "head_element"; readonly element: string };

function headChildren(node: ParentNode): readonly ChildNode[] {
  return node.childNodes;
}

/**
 * Save/install-time check for a theme's `head` template (ADR 0008 install checks): the static
 * markup must contain a title, a robots meta tag and a canonical link, and nothing but head
 * elements. Values come from Liquid, so only the tags' presence can be checked here; the
 * rendered output is enforced by `enforceHeadMarkup`.
 */
export function validateHeadTemplate(source: string): readonly HeadTemplateIssue[] {
  const document = parseDocument(`<!doctype html><html><head>${maskLiquid(source)}</head></html>`);
  const html = document.childNodes.find(
    (node): node is Element => isElement(node) && node.tagName === "html",
  );
  const head = html?.childNodes.find(
    (node): node is Element => isElement(node) && node.tagName === "head",
  );
  const body = html?.childNodes.find(
    (node): node is Element => isElement(node) && node.tagName === "body",
  );
  const issues: HeadTemplateIssue[] = [];
  const elements = head === undefined ? [] : headChildren(head).filter(isElement);

  for (const element of [...elements, ...(body === undefined ? [] : body.childNodes)]) {
    if (!isElement(element)) {
      continue;
    }

    if (headElementProblem(element) !== null) {
      issues.push({ code: "head_element", element: element.tagName.toLowerCase() });
    }
  }

  const has = (predicate: (element: Element) => boolean): boolean => elements.some(predicate);

  if (!has((element) => element.tagName === "title")) {
    issues.push({ code: "missing_meta", meta: "title" });
  }

  if (
    !has(
      (element) =>
        element.tagName === "meta" && attribute(element, "name")?.toLowerCase() === "robots",
    )
  ) {
    issues.push({ code: "missing_meta", meta: "robots" });
  }

  if (!has((element) => element.tagName === "link" && relTokens(element)[0] === "canonical")) {
    issues.push({ code: "missing_meta", meta: "canonical" });
  }

  return issues;
}
