import { describe, expect, test } from "bun:test";
import {
  createThemePreviewToken,
  THEME_PREVIEW_TTL_MS,
  verifyThemePreviewToken,
} from "./preview-token.ts";

describe("theme preview token", () => {
  test("round-trips the theme and member for the signed lifetime", () => {
    const token = createThemePreviewToken(
      { themeId: "7", memberId: "42", expiresAt: 5_000 },
      "secret",
    );

    expect(verifyThemePreviewToken(token, "secret", 4_999)).toEqual({
      themeId: "7",
      memberId: "42",
      expiresAt: 5_000,
    });
    expect(verifyThemePreviewToken(token, "different", 4_999)).toBeNull();
    expect(verifyThemePreviewToken(token, "secret", 5_000)).toBeNull();
  });

  test("uses a ten minute default and rejects tampering", () => {
    const before = Date.now();
    const token = createThemePreviewToken({ themeId: "2", memberId: "3" }, "secret");
    const claims = verifyThemePreviewToken(token, "secret");

    expect(claims?.expiresAt).toBeGreaterThanOrEqual(before + THEME_PREVIEW_TTL_MS);
    expect(verifyThemePreviewToken(token.replace(/\.[^.]+$/, ".tampered"), "secret")).toBeNull();
    expect(verifyThemePreviewToken("not-a-token", "secret")).toBeNull();
    expect(verifyThemePreviewToken(null, "secret")).toBeNull();
  });
});
