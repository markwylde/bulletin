import { describe, expect, test } from "bun:test";
import { createServerT, type Translator } from "@bulletin/i18n";
import { Liquid } from "liquidjs";
import { runtimeGlobals, type TemplateRuntime } from "./runtime.ts";
import { registerTranslationTag } from "./translation-tag.ts";

const SHIPPED = {
  en: {
    "topic.reply.button": "Reply",
    "topic.reply.count": "{count, plural, one {# reply} other {# replies}}",
  },
  es: {
    "topic.reply.button": "Responder",
    "topic.reply.count": "{count, plural, one {# respuesta} other {# respuestas}}",
  },
  fr: {
    "topic.reply.button": "Répondre",
    "topic.reply.count": "{count, plural, one {# réponse} other {# réponses}}",
  },
} as const;

function translateWith(locale: "en" | "es" | "fr"): TemplateRuntime {
  return { translate: createServerT(locale, { shipped: SHIPPED }), hooks: {} };
}

function translator(translate: Translator): TemplateRuntime {
  return { translate, hooks: {} };
}

function render(source: string, runtime: TemplateRuntime, viewModel: object = {}): Promise<string> {
  const engine = new Liquid({ strictVariables: true, strictFilters: true });
  registerTranslationTag(engine);

  return engine.render(engine.parse(source), viewModel, {
    globals: runtimeGlobals(runtime),
  }) as Promise<string>;
}

describe("{% t %}", () => {
  test("translates a key", async () => {
    expect(await render('{% t "topic.reply.button" %}', translateWith("es"))).toBe("Responder");
  });

  test("accepts a variables object", async () => {
    expect(
      await render('{% t "topic.reply.count" args %}', translateWith("fr"), {
        args: { count: 2 },
      }),
    ).toBe("2 réponses");
  });

  test("accepts named arguments", async () => {
    expect(await render('{% t "topic.reply.count" count: 3 %}', translateWith("es"))).toBe(
      "3 respuestas",
    );
  });

  test("applies override messages", async () => {
    expect(
      await render(
        '{% t "topic.reply.button" %}',
        translator(
          createServerT("en", {
            overrides: { "topic.reply.button": "Respond" },
            shipped: SHIPPED,
          }),
        ),
      ),
    ).toBe("Respond");
  });

  test("escapes translated output", async () => {
    expect(
      await render(
        '{% t "topic.reply.button" %}',
        translator(() => "<b>Reply</b>"),
      ),
    ).toBe("&lt;b&gt;Reply&lt;/b&gt;");
  });

  test("rejects a missing key at parse time", () => {
    const engine = new Liquid();
    registerTranslationTag(engine);

    expect(() => engine.parse("{% t %}")).toThrow("requires a message key");
  });
});
