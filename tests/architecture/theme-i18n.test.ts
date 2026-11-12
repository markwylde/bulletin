import { describe, expect, test } from "bun:test";
import { LOCALES } from "@bulletin/i18n";
import { STAFF_CATALOGS } from "../../apps/staff-app/src/catalogs.ts";

const TEMPLATE_CATALOGS = new URL("../../packages/templates/i18n/", import.meta.url);

async function templateCatalog(locale: string): Promise<Record<string, string>> {
  return Bun.file(new URL(`${locale}.json`, TEMPLATE_CATALOGS)).json() as Promise<
    Record<string, string>
  >;
}

describe("theme i18n completeness", () => {
  test("every theme manager string exists in English, Spanish and French", () => {
    const keys = Object.keys(STAFF_CATALOGS.en).filter((key) => key.startsWith("staff.themes."));

    expect(keys.length).toBeGreaterThan(30);

    for (const locale of LOCALES) {
      for (const key of keys) {
        expect({ locale, key, value: STAFF_CATALOGS[locale][key] }).toEqual({
          locale,
          key,
          value: expect.any(String),
        });
      }
    }
  });

  test("the chooser strings ship in every default-theme locale", async () => {
    const catalogs = await Promise.all(LOCALES.map(templateCatalog));
    const keys = [
      "theme.chooser.theme",
      "theme.chooser.scheme",
      "theme.chooser.light",
      "theme.chooser.dark",
      "theme.chooser.system",
      "theme.chooser.save",
      "theme.chooser.failed",
      "theme.chooser.settingsTitle",
    ] as const;

    for (const catalog of catalogs) {
      for (const key of keys) {
        expect(catalog[key]).toBeString();
        expect(catalog[key]?.trim()).not.toBe("");
      }
    }
  });
});
