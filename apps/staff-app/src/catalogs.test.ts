import { describe, expect, test } from "bun:test";
import { LOCALES } from "@bulletin/i18n";
import { STAFF_CATALOGS } from "./catalogs.ts";

const REQUIRED_KEYS = [
  "staff.nav.dashboard",
  "staff.nav.adminLog",
  "staff.nav.boardSettings",
  "staff.nav.strings",
  "staff.settings.board.title",
  "staff.log.title",
  "staff.strings.title",
  "ui.form.error.required",
  "ui.form.error.min",
  "ui.form.error.max",
  "ui.table.empty",
  "ui.dialog.confirm",
  "ui.toast.dismiss",
] as const;

describe("staff catalogs", () => {
  test("ships the same keys in English, Spanish and French", () => {
    const englishKeys = Object.keys(STAFF_CATALOGS.en).sort();

    for (const locale of LOCALES) {
      expect(Object.keys(STAFF_CATALOGS[locale]).sort()).toEqual(englishKeys);
    }
  });

  test("includes the shell, section and shared building-block strings", () => {
    for (const key of REQUIRED_KEYS) {
      for (const locale of LOCALES) {
        expect(STAFF_CATALOGS[locale][key]).toBeString();
        expect(STAFF_CATALOGS[locale][key]?.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
