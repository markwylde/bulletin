import { describe, expect, test } from "bun:test";
import { LOCALES } from "@bulletin/i18n";
import { USER_CATALOGS } from "../catalogs.ts";

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

function placeholders(message: string): readonly string[] {
  return [...message.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "").sort();
}

/**
 * Task 3.1: every feed title and meta description ships in en/es/fr with the same ICU
 * placeholders. The catalog checker enforces key parity; this keeps the SEO surface readable
 * for whoever changes a title next.
 */
describe("SEO strings", () => {
  test("feed titles and descriptions exist in every locale", () => {
    for (const locale of LOCALES) {
      const catalog: Readonly<Record<string, string>> = USER_CATALOGS[locale];
      const keys = Object.keys(catalog)
        .filter((key) => key.startsWith("seo.feed."))
        .sort();

      expect({ locale, keys }).toEqual({
        locale,
        keys: [
          "seo.feed.board.description",
          "seo.feed.board.title",
          "seo.feed.forum.description",
          "seo.feed.forum.title",
          "seo.feed.link.atom",
          "seo.feed.link.rss",
          "seo.feed.links",
        ],
      });
    }
  });

  test("meta descriptions exist in every locale with matching placeholders", () => {
    const englishCatalog: Readonly<Record<string, string>> = USER_CATALOGS.en;

    for (const key of Object.keys(englishCatalog).filter(
      (candidate) => candidate.startsWith("seo.") && candidate.endsWith(".description"),
    )) {
      const english = englishCatalog[key] ?? "";

      for (const locale of LOCALES) {
        const catalog: Readonly<Record<string, string>> = USER_CATALOGS[locale];
        const message = catalog[key];

        expect({ key, locale, missing: message === undefined }).toEqual({
          key,
          locale,
          missing: false,
        });
        expect({ key, locale, placeholders: placeholders(message ?? "") }).toEqual({
          key,
          locale,
          placeholders: placeholders(english),
        });
      }
    }
  });
});
