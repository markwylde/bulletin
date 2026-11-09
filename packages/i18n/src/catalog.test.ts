import { describe, expect, test } from "bun:test";
import { CATALOGS, LOCALES, localeFromBp, resolveLocale, t } from "./catalog.ts";

describe("placeholder catalogs", () => {
  test("every locale has every English key", () => {
    const keys = Object.keys(CATALOGS.en).sort();

    for (const locale of LOCALES) {
      expect(Object.keys(CATALOGS[locale]).sort()).toEqual(keys);
    }
  });

  test("resolves only shipped locales and defaults to English", () => {
    expect(resolveLocale("es")).toBe("es");
    expect(resolveLocale("fr")).toBe("fr");
    expect(resolveLocale("de")).toBe("en");
    expect(resolveLocale(null)).toBe("en");
  });

  test("reads the locale from the bp cookie", () => {
    expect(localeFromBp("es.2.dark")).toBe("es");
    expect(localeFromBp("fr.1.light")).toBe("fr");
    expect(localeFromBp("xx.1.light")).toBe("en");
    expect(localeFromBp(null)).toBe("en");
  });

  test("returns translated placeholder strings", () => {
    expect(t("es", "user.placeholder.body")).toContain("comunidad");
    expect(t("fr", "user.placeholder.body")).toContain("communauté");
  });
});
