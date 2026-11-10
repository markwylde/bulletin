import { createServerT, type Translator } from "@bulletin/i18n";
import { type DefaultTreeAdapterTypes, parse as parseHtml } from "parse5";
import en from "../i18n/en.json";

export type TemplateIssueCode =
  | "script"
  | "frame"
  | "object"
  | "embed"
  | "base"
  | "meta_refresh"
  | "event_handler"
  | "unsafe_url"
  | "off_origin_form"
  | "unsupported_tag";

/**
 * A rejected construct. Issues are machine-readable; the admin-facing text comes from the
 * translated formatter below, so every locale can name the problem (task 8.1).
 */
export interface TemplateIssue {
  readonly code: TemplateIssueCode;
  readonly line: number;
  readonly column: number;
  /** The HTML element, or the Liquid tag for `unsupported_tag`. */
  readonly element: string;
  readonly attribute?: string;
  /** Extra context for the message: the forbidden scheme or the unsupported tag name. */
  readonly detail?: string;
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

  if (trimmed.startsWith("//") || trimmed.startsWith("\\")) {
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
    issues.push({ code: banned, line, column, element: tag });
    return;
  }

  const httpEquiv = element.attrs.find((attribute) => attribute.name === "http-equiv");

  if (tag === "meta" && httpEquiv?.value.trim().toLowerCase() === "refresh") {
    const position = locationOf(element, "http-equiv");
    issues.push({
      code: "meta_refresh",
      ...position,
      element: tag,
      attribute: "http-equiv",
    });
  }

  for (const attribute of element.attrs) {
    const name =
      attribute.prefix === undefined
        ? attribute.name.toLowerCase()
        : `${attribute.prefix}:${attribute.name}`.toLowerCase();
    const position = locationOf(element, name);

    if (/^on[a-z]/.test(name)) {
      issues.push({ code: "event_handler", ...position, element: tag, attribute: name });
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
        ...position,
        element: tag,
        attribute: name,
        detail: normaliseUrl(unsafe).split(":")[0] ?? "",
      });
      continue;
    }

    if ((name === "action" || name === "formaction") && !isSameOriginTarget(attribute.value)) {
      issues.push({ code: "off_origin_form", ...position, element: tag, attribute: name });
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

/** Tags that read from the filesystem; a theme never needs them (ADR 0008 include depth 0). */
const UNSUPPORTED_TAGS = /\{%-?\s*(include|render|layout)\b/g;

function findUnsupportedTags(source: string): readonly TemplateIssue[] {
  const issues: TemplateIssue[] = [];

  for (const match of source.matchAll(UNSUPPORTED_TAGS)) {
    const offset = match.index ?? 0;
    const before = source.slice(0, offset);
    const line = before.split("\n").length;
    const tag = match[1] ?? "include";

    issues.push({
      code: "unsupported_tag",
      line,
      column: offset - before.lastIndexOf("\n"),
      element: tag,
      detail: tag,
    });
  }

  return issues;
}

/**
 * The save/install-time check for a theme template (ADR 0008): scripts, event handlers,
 * forbidden URL schemes, frames, objects, embeds, base tags, meta refresh, off-origin forms and
 * filesystem includes are rejected with the element, attribute and line.
 */
export function validateTemplateMarkup(source: string): TemplateValidation {
  const document = parseHtml(maskLiquid(source), {
    sourceCodeLocationInfo: true,
    // Parse `<noscript>` content as markup so a script hidden in it is rejected too.
    scriptingEnabled: false,
  });
  const issues: TemplateIssue[] = [];

  walk(document, issues);
  issues.push(...findUnsupportedTags(source));

  return { ok: issues.length === 0, issues };
}

/** The shipped English messages, used for server logs before a locale is known. */
const DEFAULT_TRANSLATE: Translator = createServerT("en", { shipped: { en } });

/** The translated, admin-facing text for one rejected construct. */
export function templateIssueMessage(issue: TemplateIssue, translate: Translator): string {
  switch (issue.code) {
    case "script":
      return translate("template.validation.script");
    case "frame":
      return translate("template.validation.frame", { element: issue.element });
    case "object":
      return translate("template.validation.object", { element: issue.element });
    case "embed":
      return translate("template.validation.embed", { element: issue.element });
    case "base":
      return translate("template.validation.base");
    case "meta_refresh":
      return translate("template.validation.metaRefresh");
    case "event_handler":
      return translate("template.validation.eventHandler", {
        attribute: issue.attribute ?? issue.element,
      });
    case "unsafe_url":
      return translate("template.validation.unsafeUrl", {
        attribute: issue.attribute ?? issue.element,
        scheme: issue.detail ?? "",
      });
    case "off_origin_form":
      return translate("template.validation.offOriginForm", {
        attribute: issue.attribute ?? issue.element,
      });
    case "unsupported_tag":
      return translate("template.validation.unsupportedTag", {
        tag: issue.detail ?? issue.element,
      });
  }
}

/**
 * One admin-facing line per issue, naming the problem and the line. Pass the request's
 * translator; the default is English for seed and server logs.
 */
export function formatTemplateIssues(
  issues: readonly TemplateIssue[],
  translate: Translator = DEFAULT_TRANSLATE,
): string {
  return issues
    .map((issue) =>
      translate("template.validation.line", {
        line: issue.line,
        message: templateIssueMessage(issue, translate),
      }),
    )
    .join("\n");
}
