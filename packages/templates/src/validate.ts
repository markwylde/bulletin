import { type DefaultTreeAdapterTypes, parse as parseHtml } from "parse5";

export type TemplateIssueCode =
  | "script"
  | "frame"
  | "object"
  | "embed"
  | "base"
  | "meta_refresh"
  | "event_handler"
  | "unsafe_url"
  | "off_origin_form";

export interface TemplateIssue {
  readonly code: TemplateIssueCode;
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly element: string;
  readonly attribute?: string;
}

export interface TemplateValidation {
  readonly ok: boolean;
  readonly issues: readonly TemplateIssue[];
}

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode | DefaultTreeAdapterTypes.Template;

/** ADR 0008 theme profile: elements a theme may never emit. */
const BANNED_ELEMENTS: Readonly<Record<string, TemplateIssueCode>> = {
  script: "script",
  iframe: "frame",
  frame: "frame",
  frameset: "frame",
  object: "object",
  embed: "embed",
  applet: "object",
  base: "base",
};

const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "action",
  "formaction",
  "xlink:href",
  "poster",
  "background",
  "data",
  "cite",
  "longdesc",
  "manifest",
  "ping",
]);

/** Strips the whitespace and control characters browsers ignore in a URL scheme, then lowercases. */
export function normaliseUrl(value: string): string {
  let normalised = "";

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code > 0x20 && code !== 0x7f) {
      normalised += character;
    }
  }

  return normalised.toLowerCase();
}

function hasForbiddenScheme(value: string): boolean {
  const normalised = normaliseUrl(value);
  return (
    normalised.startsWith("javascript:") ||
    normalised.startsWith("vbscript:") ||
    normalised.startsWith("data:")
  );
}

function srcsetUrls(value: string): readonly string[] {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter((candidate) => candidate !== "");
}

/**
 * Form targets must stay on this origin (ADR 0008). Empty, fragment, query, root-relative and
 * plain relative targets are same-origin; absolute and protocol-relative targets are not.
 */
function isSameOriginTarget(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("?")) {
    return true;
  }

  if (trimmed.startsWith("//") || trimmed.startsWith("\\\\")) {
    return false;
  }

  if (trimmed.startsWith("/")) {
    return true;
  }

  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

/**
 * Replaces Liquid tags and outputs with spaces (newlines preserved) so the HTML parser only
 * sees the template's static markup while line and column numbers stay exact.
 */
export function maskLiquid(source: string): string {
  const characters = source.split("");
  let index = 0;

  while (index < source.length) {
    const opening = source.slice(index, index + 2);

    if (opening !== "{{" && opening !== "{%") {
      index += 1;
      continue;
    }

    const close = opening === "{{" ? "}}" : "%}";
    const end = findTagEnd(source, index + 2, close);

    for (let cursor = index; cursor < end + 2 && cursor < characters.length; cursor += 1) {
      if (characters[cursor] !== "\n" && characters[cursor] !== "\r") {
        characters[cursor] = " ";
      }
    }

    index = end + 2;
  }

  return characters.join("");
}

/** Finds a tag's closing delimiter, skipping delimiters inside quoted arguments. */
function findTagEnd(source: string, from: number, close: string): number {
  let quote: string | null = null;

  for (let index = from; index < source.length; index += 1) {
    const character = source[index];

    if (quote !== null) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }

      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (source.startsWith(close, index)) {
      return index;
    }
  }

  return source.length;
}

function locationOf(element: Element, attribute?: string): { line: number; column: number } {
  const location = element.sourceCodeLocation;

  if (attribute !== undefined) {
    const attributeLocation = location?.attrs?.[attribute];

    if (attributeLocation !== undefined) {
      return { line: attributeLocation.startLine, column: attributeLocation.startCol };
    }
  }

  const startTag = location?.startTag ?? location;

  return { line: startTag?.startLine ?? 1, column: startTag?.startCol ?? 1 };
}

function childrenOf(node: ParentNode): readonly DefaultTreeAdapterTypes.ChildNode[] {
  if ("content" in node) {
    return node.content.childNodes;
  }

  return node.childNodes;
}

function inspectElement(element: Element, issues: TemplateIssue[]): void {
  const tag = element.tagName.toLowerCase();
  const banned = BANNED_ELEMENTS[tag];
  const { line, column } = locationOf(element);

  if (banned !== undefined) {
    issues.push({
      code: banned,
      message: `the <${tag}> element is not allowed`,
      line,
      column,
      element: tag,
    });
    return;
  }

  const httpEquiv = element.attrs.find((attribute) => attribute.name === "http-equiv");

  if (tag === "meta" && httpEquiv?.value.trim().toLowerCase() === "refresh") {
    const position = locationOf(element, "http-equiv");
    issues.push({
      code: "meta_refresh",
      message: "the http-equiv refresh meta tag is not allowed",
      ...position,
      element: tag,
      attribute: "http-equiv",
    });
  }

  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase();
    const position = locationOf(element, name);

    if (/^on[a-z]/.test(name)) {
      issues.push({
        code: "event_handler",
        message: `the ${name} attribute is not allowed`,
        ...position,
        element: tag,
        attribute: name,
      });
      continue;
    }

    if (!URL_ATTRIBUTES.has(name)) {
      continue;
    }

    const urls = name === "srcset" ? srcsetUrls(attribute.value) : [attribute.value];
    const unsafe = urls.find((url) => hasForbiddenScheme(url));

    if (unsafe !== undefined) {
      issues.push({
        code: "unsafe_url",
        message: `the ${name} attribute uses a forbidden ${normaliseUrl(unsafe).split(":")[0]}: URL`,
        ...position,
        element: tag,
        attribute: name,
      });
      continue;
    }

    if ((name === "action" || name === "formaction") && !isSameOriginTarget(attribute.value)) {
      issues.push({
        code: "off_origin_form",
        message: `the ${name} attribute must target this origin`,
        ...position,
        element: tag,
        attribute: name,
      });
    }
  }
}

function walk(node: ParentNode, issues: TemplateIssue[]): void {
  for (const child of childrenOf(node)) {
    if ("tagName" in child) {
      inspectElement(child, issues);
    }

    if ("childNodes" in child || "content" in child) {
      walk(child as ParentNode, issues);
    }
  }
}

/**
 * The save/install-time check for a theme template (ADR 0008): scripts, event handlers,
 * forbidden URL schemes, frames, objects, embeds, base tags, meta refresh and off-origin forms
 * are rejected with the element, attribute and line.
 */
export function validateTemplateMarkup(source: string): TemplateValidation {
  const document = parseHtml(maskLiquid(source), { sourceCodeLocationInfo: true });
  const issues: TemplateIssue[] = [];

  walk(document, issues);

  return { ok: issues.length === 0, issues };
}
