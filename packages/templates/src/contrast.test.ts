import { describe, expect, test } from "bun:test";
import {
  checkContrast,
  checkThemeContrast,
  contrastRatio,
  DEFAULT_THEME_CONTRAST_PAIRS,
  relativeLuminance,
  THEME_SCHEMES,
  WCAG_AA_NORMAL_TEXT,
} from "./contrast.ts";
import { loadDefaultThemeTokens } from "./theme-files.ts";

describe("WCAG contrast", () => {
  test("computes relative luminance and the ratio for black and white", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 4);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 4);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 4);
  });

  test("accepts uppercase hex and rejects values a theme could smuggle in", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 4);
    expect(contrastRatio("white", "#000000")).toBeNull();
    expect(contrastRatio("#fff", "#000000")).toBeNull();
    expect(contrastRatio("#ffffff", "var(--bl-bg)")).toBeNull();
    expect(relativeLuminance("rgb(0, 0, 0)")).toBeNull();
  });

  test("reports a pair below the minimum with its ratio", () => {
    const pairs = [{ foreground: "text", background: "bg" }] as const;
    const issues = checkContrast("light", { text: "#999999", bg: "#ffffff" }, pairs);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      scheme: "light",
      foreground: "text",
      background: "bg",
      reason: "contrast",
      minimum: WCAG_AA_NORMAL_TEXT,
    });
    expect(issues[0]?.ratio).toBeLessThan(WCAG_AA_NORMAL_TEXT);
  });

  test("a missing or malformed token fails instead of being skipped", () => {
    expect(checkContrast("dark", {}, DEFAULT_THEME_CONTRAST_PAIRS)).toHaveLength(
      DEFAULT_THEME_CONTRAST_PAIRS.length,
    );
    expect(checkContrast("dark", { text: "not-a-colour", bg: "#000000" })[0]).toMatchObject({
      reason: "invalid_colour",
      ratio: null,
    });
  });

  test("accepts every pair exactly at the minimum", () => {
    // #767676 on white is the canonical 4.54:1 AA boundary.
    expect(
      checkContrast("light", { text: "#767676", bg: "#ffffff" }, [
        { foreground: "text", background: "bg" },
      ]),
    ).toEqual([]);
  });
});

describe("default theme tokens", () => {
  test("ship both schemes and meet WCAG AA on every pair", async () => {
    const tokens = await loadDefaultThemeTokens();

    expect(Object.keys(tokens).sort()).toEqual([...THEME_SCHEMES].sort());
    expect(tokens.light.text).toBe("#1c2430");
    expect(tokens.dark.text).toBe("#e7ecf3");
    expect(checkThemeContrast(tokens)).toEqual([]);
  });

  test("a weaker accent fails the check in both schemes", async () => {
    const tokens = await loadDefaultThemeTokens();
    const washedOut = {
      light: { ...tokens.light, accent: "#9aa7c2" },
      dark: { ...tokens.dark, accent: "#303a4c" },
    };

    const issues = checkThemeContrast(washedOut);

    expect(new Set(issues.map((issue) => issue.scheme))).toEqual(new Set(["light", "dark"]));
    expect(issues.every((issue) => issue.reason === "contrast")).toBe(true);
  });
});
