import { describe, expect, test } from "bun:test";
import {
  buildManifest,
  iconLetter,
  iconSvg,
  manifestTokens,
  parseThemeReference,
  themeQuery,
} from "./manifest.ts";

const tokens = { bg: "#112233", accent: "#ff8800" };
const theme = { id: "7", version: 3, tokens };

describe("web app manifest", () => {
  test("reflects the active theme's colours and versioned icons", () => {
    const manifest = buildManifest({
      boardName: "Bulletin community",
      description: "The community forum.",
      theme,
    });

    expect(manifest.name).toBe("Bulletin community");
    expect(manifest.short_name).toBe("Bulletin com");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.background_color).toBe("#112233");
    expect(manifest.theme_color).toBe("#ff8800");
    expect(manifest.icons.map((icon) => icon.src)).toEqual([
      "/pwa/icon-192.png?theme=7%403",
      "/pwa/icon-512.png?theme=7%403",
      "/pwa/icon-512.png?theme=7%403",
    ]);
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512", "512x512"]);
    expect(manifest.icons[2]?.purpose).toBe("maskable");
  });

  test("a different theme changes the manifest colours", () => {
    const first = buildManifest({
      boardName: "Board",
      description: "",
      theme,
    });
    const second = buildManifest({
      boardName: "Board",
      description: "",
      theme: { id: "8", version: 1, tokens: { bg: "#ffffff", accent: "#5b3fa8" } },
    });

    expect(first.theme_color).not.toBe(second.theme_color);
    expect(second.theme_color).toBe("#5b3fa8");
  });

  test("only safe hex colours reach the manifest and icon markup", () => {
    expect(manifestTokens({ bg: "url(https://evil.test/x)", accent: "#ABCDEF" })).toEqual({
      bg: "#f4f6f9",
      accent: "#ABCDEF",
    });

    const svg = iconSvg({ size: 192, tokens, letter: "<B>" });
    expect(svg).toContain("&lt;B&gt;");
    expect(svg).not.toContain("<B>");
  });

  test("the icon letter is the first character of the board name, or B", () => {
    expect(iconLetter("Bulletin community")).toBe("B");
    expect(iconLetter("  élan")).toBe("É");
    expect(iconLetter("")).toBe("B");
  });

  test("parses theme references and rejects malformed ones", () => {
    expect(parseThemeReference("12@4")).toEqual({ id: "12", version: 4 });
    expect(parseThemeReference("12")).toEqual({ id: "12", version: null });
    expect(parseThemeReference("12@x")).toBeNull();
    expect(parseThemeReference("../../etc")).toBeNull();
    expect(parseThemeReference(null)).toBeNull();
    expect(themeQuery(theme)).toBe("theme=7%403");
  });
});
