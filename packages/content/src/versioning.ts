import { refreshStoredHtml } from "./refresh.ts";
import { renderVersionFor, SANITISER_VERSION } from "./replace-words.ts";
import type { ContentProfile, ReplaceWords } from "./types.ts";

export interface ContentVersions {
  readonly renderVersion: number;
  readonly sanitiserVersion: number;
}

export interface StoredRendering extends ContentVersions {
  readonly bodyHtml: string;
  readonly bodyText?: string;
}

export interface CurrentRendering {
  readonly bodyHtml: string;
  readonly bodyText: string;
  /** True when the stored HTML did not match the current versions and was rebuilt. */
  readonly refreshed: boolean;
}

/** The versions a row written by this process must carry (ADR 0007). */
export function currentContentVersions(replaceWords?: ReplaceWords): ContentVersions {
  return {
    renderVersion: renderVersionFor(replaceWords),
    sanitiserVersion: SANITISER_VERSION,
  };
}

/** A row is stale when either its pipeline or sanitiser version differs from the current one. */
export function isContentStale(stored: ContentVersions, current: ContentVersions): boolean {
  return (
    stored.renderVersion !== current.renderVersion ||
    stored.sanitiserVersion !== current.sanitiserVersion
  );
}

export interface EnsureCurrentRenderingOptions {
  readonly profile: ContentProfile;
  readonly replaceWords?: ReplaceWords;
  /** Test/deployment override; production uses the code constants. */
  readonly versions?: ContentVersions;
}

/**
 * The read-path guard: rows below the current versions are re-sanitised and re-transformed
 * before caching, so a fix applies even before the re-render job reaches the row (ADR 0007).
 * Markdown is never parsed here.
 */
export async function ensureCurrentRendering(
  stored: StoredRendering,
  options: EnsureCurrentRenderingOptions,
): Promise<CurrentRendering> {
  const current = options.versions ?? currentContentVersions(options.replaceWords);

  if (!isContentStale(stored, current)) {
    return {
      bodyHtml: stored.bodyHtml,
      bodyText: stored.bodyText ?? "",
      refreshed: false,
    };
  }

  const refreshed = await refreshStoredHtml(stored.bodyHtml, {
    profile: options.profile,
    ...(options.replaceWords === undefined ? {} : { replaceWords: options.replaceWords }),
  });

  return { ...refreshed, refreshed: true };
}
