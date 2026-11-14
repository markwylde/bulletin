import { describe, expect, test } from "bun:test";
import {
  buildSeoMetadata,
  localiseSeoMetadata,
  SEO_DESCRIPTION_MAX,
  seoDescription,
} from "./metadata.ts";

describe("page metadata", () => {
  test("suffixes the board name once and keeps a clean canonical path", () => {
    const seo = buildSeoMetadata({
      title: "General Discussion",
      boardName: "Bulletin",
      description: "Everyday conversation.",
      canonicalPath: "/topic/12-general?utm_source=feed#post-9",
    });

    expect(seo.title).toBe("General Discussion · Bulletin");
    expect(seo.canonicalPath).toBe("/topic/12-general");
    expect(seo.description).toBe("Everyday conversation.");
    expect(seo.robots).toBe("index");
    expect(seo.alternates).toEqual([
      { hreflang: "en", path: "/topic/12-general?lang=en" },
      { hreflang: "es", path: "/topic/12-general?lang=es" },
      { hreflang: "fr", path: "/topic/12-general?lang=fr" },
      { hreflang: "x-default", path: "/topic/12-general" },
    ]);
  });

  test("canonicalises page 2 without extra query parameters", () => {
    const seo = buildSeoMetadata({
      title: "A long discussion",
      boardName: "Bulletin",
      description: "Page two.",
      canonicalPath: "/topic/12-a-long-discussion/page/2?utm_campaign=newsletter&page=1",
    });

    expect(seo.canonicalPath).toBe("/topic/12-a-long-discussion/page/2");
  });

  test("does not repeat a board-name title", () => {
    const home = buildSeoMetadata({
      title: "Bulletin",
      boardName: "Bulletin",
      description: "A friendly place.",
      canonicalPath: "/",
    });

    expect(home.title).toBe("Bulletin");
  });

  test("collapses whitespace, caps descriptions and honours noindex", () => {
    expect(seoDescription("  one\n\n two\t three  ")).toBe("one two three");
    expect(seoDescription("x".repeat(SEO_DESCRIPTION_MAX + 20))).toHaveLength(SEO_DESCRIPTION_MAX);

    const seo = buildSeoMetadata({
      title: "Search",
      boardName: "Bulletin",
      description: "Results",
      canonicalPath: "/search",
      robots: "noindex",
      type: "article",
      jsonLd: { "@type": "Thing" },
    });

    expect(seo.robots).toBe("noindex");
    expect(seo.type).toBe("article");
    expect(seo.jsonLd).toEqual({ "@type": "Thing" });
  });
});

describe("localised metadata", () => {
  const seo = buildSeoMetadata({
    title: "Discusión",
    boardName: "Bulletin",
    description: "Texto.",
    canonicalPath: "/topic/12-general/page/2",
  });

  test("the board default locale is the clean URL and x-default", () => {
    const localised = localiseSeoMetadata(seo, {
      locale: "en",
      explicitLocale: false,
      boardDefaultLocale: "en",
    });

    expect(localised.canonicalPath).toBe("/topic/12-general/page/2");
    expect(localised.alternates).toEqual([
      { hreflang: "en", path: "/topic/12-general/page/2" },
      { hreflang: "es", path: "/topic/12-general/page/2?lang=es" },
      { hreflang: "fr", path: "/topic/12-general/page/2?lang=fr" },
      { hreflang: "x-default", path: "/topic/12-general/page/2" },
    ]);
  });

  test("an explicit ?lang= variant is self-canonical", () => {
    const localised = localiseSeoMetadata(seo, {
      locale: "es",
      explicitLocale: true,
      boardDefaultLocale: "en",
    });

    expect(localised.canonicalPath).toBe("/topic/12-general/page/2?lang=es");
    expect(localised.alternates).toContainEqual({
      hreflang: "es",
      path: "/topic/12-general/page/2?lang=es",
    });
    expect(localised.title).toBe(seo.title);
  });

  test("?lang= for the default locale and cookie locales canonicalise to the clean URL", () => {
    expect(
      localiseSeoMetadata(seo, { locale: "fr", explicitLocale: true, boardDefaultLocale: "fr" })
        .canonicalPath,
    ).toBe("/topic/12-general/page/2");
    expect(
      localiseSeoMetadata(seo, { locale: "es", explicitLocale: false, boardDefaultLocale: "en" })
        .canonicalPath,
    ).toBe("/topic/12-general/page/2");
  });
});
