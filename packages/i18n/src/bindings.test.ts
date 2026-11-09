import { describe, expect, test } from "bun:test";
import { createServerT, type ServerTranslatorOptions, serverT } from "./bindings.ts";

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

const options: ServerTranslatorOptions = { shipped: SHIPPED };

describe("server translator", () => {
  test("translates a message for emails and push", () => {
    expect(createServerT("en", options)("topic.reply.button")).toBe("Reply");
    expect(createServerT("es", options)("topic.reply.count", { count: 3 })).toBe("3 respuestas");
    expect(createServerT("fr", options)("topic.reply.count", { count: 1 })).toBe("1 réponse");
  });

  test("applies overrides over the shipped catalog", () => {
    const t = createServerT("en", {
      ...options,
      overrides: { "topic.reply.button": "Respond" },
    });

    expect(t("topic.reply.button")).toBe("Respond");
    expect(t("topic.reply.count", { count: 1 })).toBe("1 reply");
  });

  test("returns the key when no message exists", () => {
    expect(createServerT("en", options)("missing.key")).toBe("missing.key");
  });

  test("supports one-shot translation", () => {
    expect(serverT("es", "topic.reply.button", {}, options)).toBe("Responder");
    expect(serverT("fr", "topic.reply.count", { count: 2 }, options)).toBe("2 réponses");
  });
});
