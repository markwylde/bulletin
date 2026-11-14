import { describe, expect, test } from "bun:test";
import en from "../../i18n/en.json";
import es from "../../i18n/es.json";
import fr from "../../i18n/fr.json";

// operations-observability task 5.1: the health panel and missing-file listing are complete in
// every shipped locale (ADR 0013).
const PREFIXES = [
  "staff.systemHealth.",
  "staff.missingObjects.",
  "staff.nav.systemHealth",
  "staff.nav.missingObjects",
];

function keys(catalog: Record<string, string>): string[] {
  return Object.keys(catalog)
    .filter((key) => PREFIXES.some((prefix) => key.startsWith(prefix)))
    .sort();
}

describe("operations strings", () => {
  test("every health and missing-file string exists in en, es and fr", () => {
    const english = keys(en);

    expect(english.length).toBeGreaterThan(50);
    expect(keys(es)).toEqual(english);
    expect(keys(fr)).toEqual(english);

    for (const key of english) {
      for (const catalog of [es, fr] as Array<Record<string, string>>) {
        expect(catalog[key]?.trim()).not.toBe("");
      }
    }
  });
});
