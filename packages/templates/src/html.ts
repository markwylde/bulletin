const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for HTML output, matching LiquidJS's `outputEscape: "escape"`. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** Escapes a value placed inside a double-quoted HTML attribute. */
export function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
