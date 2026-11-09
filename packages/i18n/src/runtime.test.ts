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
      id: "acme",
      catalogs: {
        en: {
          "plugin.acme.greeting": "Hello from the plugin",
          "plugin.acme.count": "{count, plural, one {# item} other {# items}}",
        },
        fr: { "plugin.acme.greeting": "Bonjour du plugin" },
      },
    };

    expect(
      resolveRuntimeMessage({
        key: "plugin.acme.count",
        locale: "fr",
        plugin,
        shipped: {},
      }),
    ).toBe(plugin.catalogs.en["plugin.acme.count"]);

    expect(
      resolveRuntimeMessage({
        key: "topic.reply.button",
        locale: "fr",
        plugin,
        shipped: { fr: { "topic.reply.button": "Répondre" } },
      }),
    ).toBe("Répondre");
  });

  test("ignores plugin keys from core and other plugins", () => {
    const plugin = {
      id: "acme",
      catalogs: {
        fr: {
          "plugin.acme.greeting": "Salut",
          "plugin.other.greeting": "Autre",
          "topic.reply.button": "Hacked",
        },
      },
    };

    expect(
      resolveRuntimeMessage({
        key: "plugin.acme.greeting",
        locale: "fr",
        plugin,
      }),
    ).toBe("Salut");
    expect(
      resolveRuntimeMessage({
        key: "plugin.other.greeting",
        locale: "fr",
        plugin,
      }),
    ).toBeUndefined();
    expect(
      resolveRuntimeMessage({
        key: "topic.reply.button",
        locale: "fr",
        plugin,
        shipped: { fr: { "topic.reply.button": "Répondre" } },
      }),
    ).toBe("Répondre");
  });

  test("rejects plugin keys outside the owning namespace", () => {
    const validation = validateRuntimeCatalog({
      locale: "fr",
      pluginId: "acme",
      base: { "plugin.acme.greeting": "Hello" },
      catalog: {
        "plugin.acme.greeting": "Bonjour",
        "plugin.other.greeting": "Autre",
        "topic.reply.button": "Hacked",
      },
    });

    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "foreign_key", key: "plugin.other.greeting" }),
        expect.objectContaining({ code: "foreign_key", key: "topic.reply.button" }),
      ]),
    );
  });

  test("applies the override, theme, plugin, shipped lookup order", () => {
    const key = "plugin.acme.forum.greeting";
    const plugin = { id: "acme", catalogs: { fr: { [key]: "Plugin" } } };

    expect(
      resolveRuntimeMessage({
        key,
        locale: "fr",
        overrides: { [key]: "Override" },
        theme: { [key]: "Theme" },
        plugin,
      }),
    ).toBe("Override");
    expect(
      resolveRuntimeMessage({
        key,
        locale: "fr",
        theme: { [key]: "Theme" },
        plugin,
      }),
    ).toBe("Theme");
    expect(
      resolveRuntimeMessage({
        key,
        locale: "fr",
        plugin,
      }),
    ).toBe("Plugin");
    expect(
      resolveRuntimeMessage({
        key,
        locale: "fr",
        plugin: { id: "acme", catalogs: {} },
      }),
    ).toBeUndefined();
    expect(
      resolveRuntimeMessage({
        key: "custom.message",
        locale: "fr",
        shipped: { fr: { "custom.message": "Sur mesure" } },
      }),
    ).toBe("Sur mesure");
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
