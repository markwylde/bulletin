import { describe, expect, test } from "bun:test";
import {
  CATALOGS,
  CatalogError,
  formatDate,
  formatMessage,
  formatNumber,
  formatRelativeTime,
  isLocale,
  LOCALES,
  loadCatalog,
  localeFromBp,
  type MessageKey,
  parseCatalog,
  resolveLocale,
  t,
} from "./catalog.ts";

describe("shipped catalogs", () => {
  test("every locale has every English key", () => {
    const keys = Object.keys(CATALOGS.en).sort();

    for (const locale of LOCALES) {
      expect(Object.keys(CATALOGS[locale]).sort()).toEqual(keys);
    }
  });

  test("loads a catalog from a JSON file", async () => {
    const catalog = await loadCatalog(new URL("../i18n/en.json", import.meta.url));

    expect(catalog["user.placeholder.title"]).toBe("Bulletin");
    expect(catalog["topic.reply.count"]).toContain("plural");
  });

  test("rejects malformed catalogs", () => {
    expect(() => parseCatalog(null)).toThrow(CatalogError);
    expect(() => parseCatalog(["a"])).toThrow(CatalogError);
    expect(() => parseCatalog({ key: 1 })).toThrow(CatalogError);
    expect(() => parseCatalog({ "": "text" })).toThrow(CatalogError);
  });
});

describe("locale helpers", () => {
  test("resolves only shipped locales and defaults to English", () => {
    expect(resolveLocale("es")).toBe("es");
    expect(resolveLocale("fr")).toBe("fr");
    expect(resolveLocale("de")).toBe("en");
    expect(resolveLocale(null)).toBe("en");
    expect(isLocale("en")).toBe(true);
    expect(isLocale("EN")).toBe(false);
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

  test("falls back to English and then the key itself", () => {
    expect(t("es", "staff.placeholder.title")).toBe(CATALOGS.es["staff.placeholder.title"]);
    expect(t("en", "not.shipped" as MessageKey)).toBe("not.shipped");
  });
});

describe("ICU formatting", () => {
  test("formats English plurals", () => {
    expect(t("en", "topic.reply.count", { count: 0 })).toBe("No replies");
    expect(t("en", "topic.reply.count", { count: 1 })).toBe("1 reply");
    expect(t("en", "topic.reply.count", { count: 5 })).toBe("5 replies");
  });

  test("formats Spanish plurals", () => {
    expect(t("es", "topic.reply.count", { count: 0 })).toBe("Sin respuestas");
    expect(t("es", "topic.reply.count", { count: 1 })).toBe("1 respuesta");
    expect(t("es", "topic.reply.count", { count: 5 })).toBe("5 respuestas");
  });

  test("formats French plurals", () => {
    expect(t("fr", "topic.reply.count", { count: 0 })).toBe("Aucune réponse");
    expect(t("fr", "topic.reply.count", { count: 1 })).toBe("1 réponse");
    expect(t("fr", "topic.reply.count", { count: 5 })).toBe("5 réponses");
  });

  test("formats select branches", () => {
    const message = "{role, select, admin {Administrator} member {Member} other {Guest}}";

    expect(formatMessage("en", message, { role: "admin" })).toBe("Administrator");
    expect(formatMessage("en", message, { role: "member" })).toBe("Member");
    expect(formatMessage("en", message, { role: "visitor" })).toBe("Guest");
  });

  test("formats number and date arguments inside messages", () => {
    const date = new Date(Date.UTC(2026, 0, 2, 12));

    expect(formatMessage("es", "{count, number} elementos", { count: 1234.5 })).toBe(
      `${new Intl.NumberFormat("es").format(1234.5)} elementos`,
    );
    expect(formatMessage("fr", "{when, date, medium}", { when: date })).toBe(
      new Intl.DateTimeFormat("fr", { dateStyle: "medium" }).format(date),
    );
  });

  test("formats numbers for the active locale", () => {
    expect(formatNumber(1234.5, "es")).toBe(new Intl.NumberFormat("es").format(1234.5));
    expect(formatNumber(1234.5, "fr")).toBe("1\u202f234,5");
    expect(formatNumber(1234.5, "en")).toBe("1,234.5");
  });

  test("formats dates for the active locale", () => {
    const date = new Date(Date.UTC(2026, 0, 2, 12));

    expect(formatDate(date, "en")).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date),
    );
    expect(formatDate(date, "es")).toBe("2 ene 2026");
    expect(formatDate(date, "fr")).toBe("2 janv. 2026");
  });

  test("formats relative times for the active locale", () => {
    expect(formatRelativeTime(-1, "day", "en")).toBe("yesterday");
    expect(formatRelativeTime(-1, "day", "es")).toBe("ayer");
    expect(formatRelativeTime(-1, "day", "fr")).toBe("hier");
  });

  test("parses and reuses compiled messages", () => {
    const message = "{count, plural, one {# item} other {# items}}";

    expect(formatMessage("en", message, { count: 1 })).toBe("1 item");
    expect(formatMessage("en", message, { count: 2 })).toBe("2 items");
  });
});
