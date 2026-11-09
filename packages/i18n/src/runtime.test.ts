import { describe, expect, test } from "bun:test";
import {
  catalogCompleteness,
  messagePlaceholders,
  resolveRuntimeMessage,
  validateRuntimeCatalog,
  validateRuntimeMessage,
} from "./runtime.ts";

const BASE = {
  "forum.greeting": "Hello",
  "topic.reply.count": "{count, plural, one {# reply} other {# replies}}",
} as const;

describe("runtime message validation", () => {
  test("collects placeholders from every plural branch", () => {
    expect([...messagePlaceholders("en", BASE["topic.reply.count"])]).toEqual(["count"]);
    expect([
      ...messagePlaceholders(
        "en",
        "{role, select, admin {{count, number} admin} other {{name} guest}}",
      ),
    ]).toEqual(["role", "count", "name"]);
  });

  test("rejects invalid ICU syntax", () => {
    const [issue] = validateRuntimeMessage({
      locale: "en",
      key: "topic.reply.count",
      message: "{count, plural, one {# reply}",
      baseMessage: BASE["topic.reply.count"],
    });

    expect(issue).toMatchObject({ code: "invalid_icu", key: "topic.reply.count" });
  });

  test("rejects a missing placeholder and names it", () => {
    const [issue] = validateRuntimeMessage({
      locale: "en",
      key: "topic.reply.count",
      message: "One or many replies",
      baseMessage: BASE["topic.reply.count"],
    });

    expect(issue).toMatchObject({
      code: "placeholder_mismatch",
      missingPlaceholders: ["count"],
      extraPlaceholders: [],
    });
    expect(issue?.message).toContain("missing {count}");
  });

  test("rejects an unexpected placeholder", () => {
    const [issue] = validateRuntimeMessage({
      locale: "en",
      key: "forum.greeting",
      message: "Hello {name}",
      baseMessage: BASE["forum.greeting"],
    });

    expect(issue).toMatchObject({
      code: "placeholder_mismatch",
      missingPlaceholders: [],
      extraPlaceholders: ["name"],
    });
  });

  test("accepts matching placeholders", () => {
    expect(
      validateRuntimeMessage({
        locale: "es",
        key: "topic.reply.count",
        message: "{count, plural, one {# respuesta} other {# respuestas}}",
        baseMessage: BASE["topic.reply.count"],
      }),
    ).toEqual([]);
  });
});

describe("runtime catalog completeness and fallback", () => {
  test("reports missing keys below 100% without treating them as errors", () => {
    const validation = validateRuntimeCatalog({
      locale: "fr",
      base: BASE,
      catalog: { "forum.greeting": "Bonjour" },
    });

    expect(validation.issues).toEqual([]);
    expect(validation.completeness).toEqual({
      totalKeys: 2,
      presentKeys: 1,
      missingKeys: ["topic.reply.count"],
      percentage: 50,
    });
  });

  test("falls back to the plugin's English key, then the shipped catalog", () => {
    const plugin = {
      en: BASE,
      fr: { "forum.greeting": "Bonjour" },
    };

    expect(
      resolveRuntimeMessage({
        key: "topic.reply.count",
        locale: "fr",
        plugin,
        shipped: {},
      }),
    ).toBe(BASE["topic.reply.count"]);

    expect(
      resolveRuntimeMessage({
        key: "user.placeholder.title",
        locale: "fr",
        plugin,
      }),
    ).toBe("Bulletin");
  });

  test("applies the override, theme, plugin, shipped lookup order", () => {
    const plugin = { fr: { "forum.greeting": "Plugin" } };

    expect(
      resolveRuntimeMessage({
        key: "forum.greeting",
        locale: "fr",
        overrides: { "forum.greeting": "Override" },
        theme: { "forum.greeting": "Theme" },
        plugin,
      }),
    ).toBe("Override");
    expect(
      resolveRuntimeMessage({
        key: "forum.greeting",
        locale: "fr",
        theme: { "forum.greeting": "Theme" },
        plugin,
      }),
    ).toBe("Theme");
    expect(
      resolveRuntimeMessage({
        key: "forum.greeting",
        locale: "fr",
        plugin,
      }),
    ).toBe("Plugin");
    expect(
      resolveRuntimeMessage({
        key: "forum.greeting",
        locale: "fr",
        plugin: {},
      }),
    ).toBeUndefined();
    expect(
      resolveRuntimeMessage({
        key: "user.placeholder.body",
        locale: "fr",
        shipped: { fr: { "user.placeholder.body": "Corps" } },
      }),
    ).toBe("Corps");
  });

  test("catalogCompleteness handles an empty base", () => {
    expect(catalogCompleteness({}, {})).toEqual({
      totalKeys: 0,
      presentKeys: 0,
      missingKeys: [],
      percentage: 100,
    });
  });
});
