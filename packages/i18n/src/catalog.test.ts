import { describe, expect, test } from "bun:test";
import {
  CATALOGS,
  CatalogError,
  compiledMessageCacheStats,
  formatDate,
  formatMessage,
  formatNumber,
  formatRelativeTime,
  isLocale,
  LOCALES,
  loadCatalog,
  parseCatalog,
  t,
} from "./catalog.ts";

const REPLY_COUNT = {
  en: "{count, plural, =0 {No replies} one {# reply} other {# replies}}",
  es: "{count, plural, =0 {Sin respuestas} one {# respuesta} other {# respuestas}}",
  fr: "{count, plural, =0 {Aucune réponse} one {# réponse} other {# réponses}}",
} as const;

describe("shipped catalogs", () => {
  test("every locale has every English key", () => {
    const keys = Object.keys(CATALOGS.en).sort();

    for (const locale of LOCALES) {
      expect(Object.keys(CATALOGS[locale]).sort()).toEqual(keys);
    }
  });

  test("loads a catalog from a JSON file", async () => {
    const catalog = await loadCatalog(new URL("../fixtures/messages.json", import.meta.url));

    expect(catalog["test.greeting"]).toBe("Hello");
    expect(catalog["test.reply.count"]).toContain("plural");
  });

  test("rejects malformed catalogs", () => {
    expect(() => parseCatalog(null)).toThrow(CatalogError);
    expect(() => parseCatalog(["a"])).toThrow(CatalogError);
    expect(() => parseCatalog({ key: 1 })).toThrow(CatalogError);
    expect(() => parseCatalog({ "": "text" })).toThrow(CatalogError);
  });
});

describe("catalog lookup", () => {
  test("recognises only shipped locales", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("EN")).toBe(false);
  });

  test("returns the key when the shipped catalog has no message", () => {
    expect(t("en", "not.shipped")).toBe("not.shipped");
    expect(t("en", "toString")).toBe("toString");
  });
});

describe("ICU formatting", () => {
  test("formats English plurals", () => {
    expect(formatMessage("en", REPLY_COUNT.en, { count: 0 })).toBe("No replies");
    expect(formatMessage("en", REPLY_COUNT.en, { count: 1 })).toBe("1 reply");
    expect(formatMessage("en", REPLY_COUNT.en, { count: 5 })).toBe("5 replies");
  });

  test("formats Spanish plurals", () => {
    expect(formatMessage("es", REPLY_COUNT.es, { count: 0 })).toBe("Sin respuestas");
    expect(formatMessage("es", REPLY_COUNT.es, { count: 1 })).toBe("1 respuesta");
    expect(formatMessage("es", REPLY_COUNT.es, { count: 5 })).toBe("5 respuestas");
  });

  test("formats French plurals", () => {
    expect(formatMessage("fr", REPLY_COUNT.fr, { count: 0 })).toBe("Aucune réponse");
    expect(formatMessage("fr", REPLY_COUNT.fr, { count: 1 })).toBe("1 réponse");
    expect(formatMessage("fr", REPLY_COUNT.fr, { count: 5 })).toBe("5 réponses");
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

  test("evicts compiled messages when the bounded cache fills", () => {
    for (let index = 0; index < 200; index += 1) {
      formatMessage("en", `${"x".repeat(4096)} {value} ${index}`, { value: index });
    }

    const stats = compiledMessageCacheStats();
    expect(stats.entries).toBeLessThan(200);
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
  });
});
