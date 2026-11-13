import { describe, expect, test } from "bun:test";
import { validateJsonSchema } from "./json-schema.ts";

const summarySchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    postId: { type: "string" },
    mine: { anyOf: [{ type: "string" }, { type: "null" }] },
    summary: { type: "object", additionalProperties: { type: "number" } },
  },
  required: ["ok", "postId", "mine", "summary"],
  additionalProperties: false,
};

describe("validateJsonSchema", () => {
  test("accepts a value that matches every keyword", () => {
    expect(
      validateJsonSchema(summarySchema, {
        ok: true,
        postId: "12",
        mine: "3",
        summary: { "3": 1 },
      }),
    ).toEqual([]);
    expect(
      validateJsonSchema(summarySchema, { ok: true, postId: "12", mine: null, summary: {} }),
    ).toEqual([]);
  });

  test("reports missing, undescribed and mistyped properties", () => {
    expect(
      validateJsonSchema(summarySchema, { ok: true, postId: "12", summary: { "3": "one" } }),
    ).toEqual(["$.mine: required property is missing", "$.summary.3: expected number, got string"]);
    expect(
      validateJsonSchema(summarySchema, { ok: "yes", postId: "1", mine: 1, summary: {} }),
    ).toEqual(["$.ok: expected boolean, got string", "$.mine: matches none of the anyOf branches"]);
    expect(
      validateJsonSchema(
        { type: "object", properties: {}, additionalProperties: false },
        { extra: 1 },
      ),
    ).toEqual(["$.extra: property is not described by the schema"]);
  });

  test("checks array items", () => {
    expect(validateJsonSchema({ type: "array", items: { type: "string" } }, ["a", 2, "c"])).toEqual(
      ["$[1]: expected string, got number"],
    );
  });
});
