import { describe, expect, test } from "bun:test";
import { createServerT, type Translator } from "@bulletin/i18n";
import { Liquid } from "liquidjs";
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

function engineWith(translate: Translator): Liquid {
  const engine = new Liquid({ strictVariables: true, strictFilters: true });
  registerTranslationTag(engine, { translate });
  return engine;
}

describe("{% t %}", () => {
  test("translates a key", async () => {
    const engine = engineWith(createServerT("es", { shipped: SHIPPED }));

    expect(await engine.parseAndRender('{% t "topic.reply.button" %}', {})).toBe("Responder");
  });

  test("accepts a variables object", async () => {
    const engine = engineWith(createServerT("fr", { shipped: SHIPPED }));

    expect(
      await engine.parseAndRender('{% t "topic.reply.count" args %}', {
        args: { count: 2 },
      }),
    ).toBe("2 réponses");
  });

  test("accepts named arguments", async () => {
    const engine = engineWith(createServerT("es", { shipped: SHIPPED }));

    expect(await engine.parseAndRender('{% t "topic.reply.count" count: 3 %}', {})).toBe(
      "3 respuestas",
    );
  });

  test("applies override messages", async () => {
    const engine = engineWith(
      createServerT("en", {
        overrides: { "topic.reply.button": "Respond" },
        shipped: SHIPPED,
      }),
    );

    expect(await engine.parseAndRender('{% t "topic.reply.button" %}', {})).toBe("Respond");
  });

  test("escapes translated output", async () => {
    const engine = engineWith(() => "<b>Reply</b>");

    expect(await engine.parseAndRender('{% t "topic.reply.button" %}', {})).toBe(
      "&lt;b&gt;Reply&lt;/b&gt;",
    );
  });

  test("rejects a missing key at parse time", () => {
    const engine = engineWith(createServerT("en"));

    expect(() => engine.parse("{% t %}")).toThrow("requires a message key");
  });
});
