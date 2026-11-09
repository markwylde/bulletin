import { describe, expect, test } from "bun:test";
import { localeFromRequest } from "./locale.ts";

describe("staff locale resolution", () => {
  test("uses the query parameter first", () => {
    expect(localeFromRequest("?lang=es", "")).toBe("es");
    expect(localeFromRequest("?lang=fr", "bp=en.1.light")).toBe("fr");
  });

  test("falls back to the bp cookie and then English", () => {
    expect(localeFromRequest("", "bp=fr.2.dark")).toBe("fr");
    expect(localeFromRequest("", "theme=dark")).toBe("en");
    expect(localeFromRequest("?lang=de", "bp=es.1.light")).toBe("en");
  });
});
