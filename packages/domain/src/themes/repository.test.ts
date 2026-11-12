import { describe, expect, test } from "bun:test";
import {
  isSafeTokenValue,
  validateTokenInput,
  validTemplateName,
  validThemeName,
} from "./repository.ts";

describe("theme input validation", () => {
  test("accepts the design tokens the default theme uses", () => {
    expect(
      validateTokenInput({
        scheme: "dark",
        tokens: {
          bg: "#141a22",
          "accent-text": "#0d1420",
          font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          width: "48rem",
        },
      }),
    ).toEqual({
      scheme: "dark",
      tokens: {
        bg: "#141a22",
        "accent-text": "#0d1420",
        font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        width: "48rem",
      },
    });
  });

  test("an empty token removes the override instead of failing", () => {
    expect(
      validateTokenInput({ scheme: "light", tokens: { accent: "", text: "#111111" } }),
    ).toEqual({ scheme: "light", tokens: { text: "#111111" } });
  });

  test("rejects values that could escape the declaration or load an external resource", () => {
    for (const value of [
      "red; background: url(https://evil.example/x)",
      "a }",
      "url(/x)",
      'image-set("https://evil.example/x" 1x)',
      "image(https://evil.example/x)",
      "cross-fade(https://evil.example/x)",
    ]) {
      expect(validateTokenInput({ scheme: "light", tokens: { accent: value } })).toBeNull();
      expect(isSafeTokenValue(value)).toBe(false);
    }
  });

  test("theme and template names stay in their namespaces", () => {
    expect(validThemeName("my-theme")).toBe("my-theme");
    expect(validThemeName("My Theme")).toBeNull();
    expect(validTemplateName("account-notifications")).toBe("account-notifications");
    expect(validTemplateName("../../etc/passwd")).toBeNull();
  });
});
