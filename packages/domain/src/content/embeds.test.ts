import { describe, expect, test } from "bun:test";
import { parseEmbedProviderInput } from "./embeds.ts";

describe("embed provider validation", () => {
  test("accepts a safe HTTPS provider", () => {
    const result = parseEmbedProviderInput({
      key: "example",
      title: "Example",
      urlPattern: "^https?://example\\.com/v/(\\w+)$",
      embedUrl: "https://player.example.com/{id}",
      enabled: true,
      position: 2,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        key: "example",
        title: "Example",
        urlPattern: "^https?://example\\.com/v/(\\w+)$",
        embedUrl: "https://player.example.com/{id}",
        enabled: true,
        position: 2,
      },
    });
  });

  test("rejects invalid keys, patterns and templates", () => {
    expect(
      parseEmbedProviderInput({
        key: "Bad Key",
        title: "",
        urlPattern: "(",
        embedUrl: "http://player.example.com/{id}",
      }),
    ).toEqual({
      ok: false,
      fields: ["key", "title", "urlPattern", "embedUrl"],
    });
  });

  test("requires the {id} placeholder", () => {
    const result = parseEmbedProviderInput({
      key: "example",
      title: "Example",
      urlPattern: "^https?://example\\.com/v/(\\w+)$",
      embedUrl: "https://player.example.com/fixed",
    });

    expect(result).toMatchObject({ ok: false, fields: ["embedUrl"] });
  });
});
