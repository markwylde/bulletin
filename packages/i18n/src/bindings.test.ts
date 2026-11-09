import { describe, expect, test } from "bun:test";
import { createServerT, serverT } from "./bindings.ts";

describe("server translator", () => {
  test("translates a shipped message for emails and push", () => {
    expect(createServerT("en")("topic.reply.button")).toBe("Reply");
    expect(createServerT("es")("topic.reply.count", { count: 3 })).toBe("3 respuestas");
    expect(createServerT("fr")("topic.reply.count", { count: 1 })).toBe("1 réponse");
  });

  test("applies overrides over the shipped catalog", () => {
    const t = createServerT("en", {
      overrides: { "topic.reply.button": "Respond" },
    });

    expect(t("topic.reply.button")).toBe("Respond");
    expect(t("topic.reply.count", { count: 1 })).toBe("1 reply");
  });

  test("returns the key when no message exists", () => {
    expect(createServerT("en")("missing.key")).toBe("missing.key");
  });

  test("supports one-shot translation", () => {
    expect(serverT("es", "topic.reply.button")).toBe("Responder");
    expect(serverT("fr", "topic.reply.count", { count: 2 })).toBe("2 réponses");
  });
});
