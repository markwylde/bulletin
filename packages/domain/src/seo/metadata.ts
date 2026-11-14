/** Search metadata shared by every public route and the default theme's head (design). */

export const SEO_DESCRIPTION_MAX = 160;
export const SEO_LOCALES = ["en", "es", "fr"] as const;

export type SeoRobots = "index" | "noindex";
export type SeoOpenGraphType = "website" | "article" | "profile";

export interface SeoAlternate {
  readonly hreflang: string;
  readonly path: string;
}

export interface SeoMetadata {
  readonly title: string;
  readonly description: string;
  /** Clean, canonical page path; query strings and fragments never survive. */
  readonly canonicalPath: string;
  readonly robots: SeoRobots;
  readonly type: SeoOpenGraphType;
  /** Locale variants link to the same path with `?lang=` (the app's locale selector). */
  readonly alternates: readonly SeoAlternate[];
  readonly jsonLd: Readonly<Record<string, unknown>> | null;
}

/** Collapses whitespace and limits a description; empty input stays empty for the caller's fallback. */
export function seoDescription(
  value: string | null | undefined,
  max = SEO_DESCRIPTION_MAX,
): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();

  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function cleanPath(value: string): string {
  const [withoutFragment] = value.split("#");
  const [path] = (withoutFragment ?? "/").split("?");

  if (path === undefined || path === "") {
    return "/";
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function localeHref(path: string, locale: string): string {
  return `${path}?lang=${locale}`;
}

/**
 * Builds one page's metadata. The canonical is always the clean path, which is what makes a
 * paged topic with tracking parameters canonicalise to its own page URL (spec scenario).
 */
export function buildSeoMetadata(input: {
  readonly title: string;
  readonly boardName: string;
  readonly description: string;
  readonly canonicalPath: string;
  readonly robots?: SeoRobots;
  readonly type?: SeoOpenGraphType;
  readonly jsonLd?: Readonly<Record<string, unknown>> | null;
}): SeoMetadata {
  const boardName = input.boardName.trim();
  const pageTitle = input.title.trim();
  const title =
    pageTitle === "" || pageTitle === boardName
      ? boardName
      : boardName === ""
        ? pageTitle
        : `${pageTitle} · ${boardName}`;
  const canonicalPath = cleanPath(input.canonicalPath);

  return {
    title,
    description: seoDescription(input.description),
    canonicalPath,
    robots: input.robots ?? "index",
    type: input.type ?? "website",
    alternates: [
      ...SEO_LOCALES.map((locale) => ({
        hreflang: locale,
        path: localeHref(canonicalPath, locale),
      })),
      { hreflang: "x-default", path: canonicalPath },
    ],
    jsonLd: input.jsonLd ?? null,
  };
}
