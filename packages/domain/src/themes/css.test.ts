import { describe, expect, test } from "bun:test";
import { filterThemeCss } from "./css.ts";

describe("theme CSS filter", () => {
  test("accepts ordinary CSS and local theme asset URLs", () => {
    const result = filterThemeCss(
      ":root { --bl-accent: #3157c7; } .logo { background-image: url('/theme-assets/logo.png'); }",
    );

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.css).toContain("--bl-accent");
      expect(result.css).toContain("/theme-assets/logo.png");
    }
  });

  test("rejects an external @import", () => {
    expect(filterThemeCss('@import url("https://evil.example/x.css");')).toEqual({
      ok: false,
      code: "import",
    });
  });

  test("rejects an obfuscated @import after lightningcss normalises it", () => {
    const result = filterThemeCss('@\\69mport "https://evil.example/x.css";');

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("import");
  });

  test("rejects every external url()", () => {
    for (const value of [
      "https://evil.example/x.png",
      "//evil.example/x.png",
      "data:image/png;base64,AAAA",
      "/other/path.png",
      "/theme-assets/../../api/secret",
    ]) {
      const result = filterThemeCss(`.x { background: url("${value}"); }`);

      expect(result.ok ? "" : result.code).toBe("external_url");
    }
  });

  test("rejects legacy expressions and malformed CSS", () => {
    expect(filterThemeCss(".x { width: expression(alert(1)); }")).toMatchObject({
      ok: false,
      code: "expression",
    });
    expect(filterThemeCss(".x { color: ")).toMatchObject({ ok: false, code: "syntax" });
  });

  test("rejects an oversized stylesheet", () => {
    expect(filterThemeCss("a".repeat(200_001))).toMatchObject({ ok: false, code: "too_large" });
  });
});
