import type { SeoMetadata } from "@bulletin/domain/seo";
import type { ThemeHeadSeo } from "@bulletin/templates";

function absolute(path: string, origin: string): string {
  try {
    return new URL(path, origin).toString();
  } catch {
    return path;
  }
}

/** The theme `head` template's `seo` view model: route metadata with absolute URLs. */
export function themeHeadSeo(
  seo: SeoMetadata,
  input: { readonly origin: string; readonly locale: string },
): ThemeHeadSeo {
  return {
    title: seo.title,
    description: seo.description,
    canonical: absolute(seo.canonicalPath, input.origin),
    robots: seo.robots,
    type: seo.type,
    locale: input.locale,
    alternates: seo.alternates.map((alternate) => ({
      hreflang: alternate.hreflang,
      href: absolute(alternate.path, input.origin),
    })),
  };
}

/**
 * JSON-LD is app markup, not theme markup (themes cannot emit scripts, ADR 0008). `<` is
 * escaped so a string value can never close the script element.
 */
export function jsonLdText(seo: SeoMetadata): string | null {
  return seo.jsonLd === null ? null : JSON.stringify(seo.jsonLd).replaceAll("<", "\\u003c");
}
