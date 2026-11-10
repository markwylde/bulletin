import { escapeHtml } from "./html.ts";

const SAFE_HTML_BRAND = Symbol.for("bulletin.safe-html");

/**
 * Already-sanitised HTML from a trusted view-model field (ADR 0007, 0008). Templates cannot
 * construct one: only view models do, through {@link safeHtml}. No filter may return one.
 */
export class SafeHtml {
  readonly html: string;
  readonly [SAFE_HTML_BRAND] = true;

  constructor(html: string) {
    this.html = html;
  }

  toString(): string {
    return this.html;
  }
}

/** Marks sanitised HTML as safe for template output. */
export function safeHtml(html: string): SafeHtml {
  return new SafeHtml(html);
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return value instanceof SafeHtml;
}

/**
 * The engine's `outputEscape` filter (ADR 0008). It runs on every `{{ }}` output, so the only
 * way raw markup reaches a page is a `SafeHtml` view-model field.
 */
export function escapeOutput(value: unknown): string {
  if (isSafeHtml(value)) {
    return value.html;
  }

  if (value === null || value === undefined) {
    return "";
  }

  return escapeHtml(String(value));
}
