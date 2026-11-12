/** Sentinels `ts_headline` writes around a match; they never appear in stored content. */
export const SNIPPET_START = "\u0001";
export const SNIPPET_STOP = "\u0002";

/** Private-use stand-ins for `<`/`>` so `ts_headline` cannot mistake content for HTML tags. */
export const SNIPPET_LT = "\uE000";
export const SNIPPET_GT = "\uE001";

export const BODY_SNIPPET_OPTIONS = `StartSel=${SNIPPET_START},StopSel=${SNIPPET_STOP},MaxFragments=2,MaxWords=35,MinWords=15,FragmentDelimiter= …`;

export const TITLE_SNIPPET_OPTIONS = `StartSel=${SNIPPET_START},StopSel=${SNIPPET_STOP},MaxFragments=0,MaxWords=50,MinWords=1`;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * `ts_headline` returns plain text with our sentinels around matches. Escape everything first,
 * so content such as `<b>` stays literal; only a sentinel becomes real `<mark>` markup
 * (ADR 0017). A stray sentinel in the source can at worst add an empty mark, never HTML.
 */
export function renderSearchSnippet(headline: string): string {
  const start = "\u0000start\u0000";
  const stop = "\u0000stop\u0000";
  const marked = headline
    .replaceAll(SNIPPET_LT, "<")
    .replaceAll(SNIPPET_GT, ">")
    .replaceAll(SNIPPET_START, start)
    .replaceAll(SNIPPET_STOP, stop);

  return escapeHtml(marked).replaceAll(start, "<mark>").replaceAll(stop, "</mark>");
}
