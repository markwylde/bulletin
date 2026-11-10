import type { QuoteSourceKind, QuoteSourceRef } from "./types.ts";

export interface QuoteSnapshotView {
  readonly id: string;
  readonly sourceKind: QuoteSourceKind;
  readonly sourceId: string;
  readonly sourceAuthorId: string | null;
  readonly bodyHtml: string;
  readonly redactedAt: Date | null;
}

export interface QuoteViewResolver {
  loadSnapshot(snapshotId: string): Promise<QuoteSnapshotView | null>;
  /** Read access is rechecked for the viewer at fragment build time (ADR 0007). */
  canRead(ref: QuoteSourceRef, viewerId: string | null): Promise<boolean>;
  /** Canonical link to the source post; null when the source has no page (messages). */
  sourceUrl(ref: QuoteSourceRef): string | null;
}

export type QuoteViewState = "quote" | "unavailable" | "redacted";

export interface ResolvedQuote {
  readonly state: QuoteViewState;
  readonly html: string;
}

export interface QuoteViewOptions {
  readonly resolver: QuoteViewResolver;
  readonly viewerId: string | null;
  readonly translate: (key: string) => string;
}

const PLACEHOLDER = /<bl-quote\b([^>]*)><\/bl-quote>/gi;
const ATTRIBUTE = /\b(data-source-kind|data-source|data-snapshot)="([^"]*)"/gi;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1];
    const value = match[2];

    if (name !== undefined && value !== undefined) {
      found.set(name.toLowerCase(), value);
    }
  }

  return found;
}

function sourceFrom(map: Map<string, string>): QuoteSourceRef | null {
  const kind = map.get("data-source-kind");
  const id = map.get("data-source");

  if ((kind !== "post" && kind !== "message") || id === undefined || !/^\d+$/.test(id)) {
    return null;
  }

  return { kind, id };
}

function sourceLink(
  ref: QuoteSourceRef,
  resolver: QuoteViewResolver,
  translate: QuoteViewOptions["translate"],
): string {
  const url = resolver.sourceUrl(ref);

  return url === null
    ? ""
    : `<a class="quote-source" href="${escapeHtml(url)}" rel="nofollow ugc noopener">${escapeHtml(
        translate("content.quote.viewSource"),
      )}</a>`;
}

async function resolveOne(
  attributesSource: string,
  options: QuoteViewOptions,
): Promise<ResolvedQuote> {
  const map = attributes(attributesSource);
  const ref = sourceFrom(map);
  const snapshotId = map.get("data-snapshot");

  if (ref === null || snapshotId === undefined) {
    return {
      state: "unavailable",
      html: `<blockquote class="quote quote-unavailable"><p>${escapeHtml(
        options.translate("content.quote.unavailable"),
      )}</p></blockquote>`,
    };
  }

  const snapshot = await options.resolver.loadSnapshot(snapshotId);

  if (
    snapshot === null ||
    snapshot.sourceKind !== ref.kind ||
    snapshot.sourceId !== ref.id ||
    !(await options.resolver.canRead(ref, options.viewerId))
  ) {
    return {
      state: "unavailable",
      html: `<blockquote class="quote quote-unavailable"><p>${escapeHtml(
        options.translate("content.quote.unavailable"),
      )}</p></blockquote>`,
    };
  }

  if (snapshot.redactedAt !== null) {
    const link = sourceLink(ref, options.resolver, options.translate);

    return {
      state: "redacted",
      html: `<blockquote class="quote quote-redacted"><p>${escapeHtml(
        options.translate("content.quote.redacted"),
      )}</p>${link}</blockquote>`,
    };
  }

  const link = sourceLink(ref, options.resolver, options.translate);

  return {
    state: "quote",
    html: `<blockquote class="quote"><div class="quote-body">${snapshot.bodyHtml}</div>${link}</blockquote>`,
  };
}

/**
 * Replaces stored `<bl-quote>` placeholders with the viewer's resolution (ADR 0007).
 * Unreadable or deleted sources never leak snapshot text, even for moderators.
 */
export async function resolveQuotePlaceholders(
  html: string,
  options: QuoteViewOptions,
): Promise<string> {
  const found = [...html.matchAll(PLACEHOLDER)];

  if (found.length === 0) {
    return html;
  }

  const replacements = await Promise.all(
    found.map(async (match) => resolveOne(match[1] ?? "", options)),
  );

  let index = 0;

  return html.replace(PLACEHOLDER, () => replacements[index++]?.html ?? "");
}
