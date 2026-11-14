import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  DEFAULT_PRIVACY_SETTINGS,
  parsePrivacySettingsInput,
  readPrivacySettings,
} from "./settings.ts";

describe("privacy retention settings", () => {
  test("uses the ADR 0012 defaults when every field is omitted", () => {
    const parsed = parsePrivacySettingsInput({});

    expect(parsed).toEqual({ ok: true, value: DEFAULT_PRIVACY_SETTINGS });
    expect(DEFAULT_PRIVACY_SETTINGS).toEqual({
      ipLogDays: 90,
      sessionMetaDays: 30,
      revokedSessionDays: 7,
      accessLogDays: 730,
      exportDays: 7,
      ipBanDays: 365,
    });
  });

  test("keeps valid integers and reports every invalid field", () => {
    const parsed = parsePrivacySettingsInput({
      ipLogDays: 100,
      sessionMetaDays: 45,
      revokedSessionDays: 10,
      accessLogDays: 1_000,
      exportDays: 14,
      ipBanDays: 500,
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        ipLogDays: 100,
        sessionMetaDays: 45,
        revokedSessionDays: 10,
        accessLogDays: 1_000,
        exportDays: 14,
        ipBanDays: 500,
      },
    });

    expect(
      parsePrivacySettingsInput({
        ipLogDays: 0,
        sessionMetaDays: 1.5,
        revokedSessionDays: -1,
        accessLogDays: 3_651,
        exportDays: "7",
        ipBanDays: null,
      }),
    ).toEqual({
      ok: false,
      fields: [
        "ipLogDays",
        "sessionMetaDays",
        "revokedSessionDays",
        "accessLogDays",
        "exportDays",
        "ipBanDays",
      ],
    });

    expect(parsePrivacySettingsInput(null)).toEqual({ ok: false, fields: ["form"] });
  });

  test("falls back to defaults when the settings row is missing", async () => {
    const sql = (async () => []) as unknown as SQL;

    expect(await readPrivacySettings(sql)).toEqual(DEFAULT_PRIVACY_SETTINGS);
  });
});
