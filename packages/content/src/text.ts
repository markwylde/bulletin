import type { Element, Nodes, Root, Text } from "hast";

const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "blockquote",
  "div",
  "dl",
  "dt",
  "dd",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const SKIPPED_ELEMENTS = new Set(["bl-quote", "script", "style"]);

function walk(node: Nodes, parts: string[]): void {
  if (node.type === "text") {
    parts.push((node as Text).value);
    return;
  }

  if (node.type === "comment" || node.type === "doctype") {
    return;
  }

  if (node.type !== "element") {
    if ("children" in node) {
      for (const child of node.children) {
        walk(child, parts);
      }
    }

    return;
  }

  const element = node as Element;

  if (SKIPPED_ELEMENTS.has(element.tagName)) {
    return;
  }

  if (element.tagName === "br") {
    parts.push("\n");
    return;
  }

  if (element.tagName === "img") {
    const alt = element.properties.alt;
    parts.push(typeof alt === "string" ? alt : "");
    return;
  }

  const block = BLOCK_ELEMENTS.has(element.tagName);

  if (block) {
    parts.push("\n");
  }

  for (const child of element.children) {
    walk(child, parts);
  }

  if (block) {
    parts.push("\n");
  }
}

/** Plain text for search, previews and notifications; quote placeholders are skipped. */
export function toPlainText(tree: Root): string {
  const parts: string[] = [];
  walk(tree, parts);

  return parts
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
