import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { buildOpenApiDocument, toJsonSchema } from "./openapi.ts";
import { defineApiRoute } from "./route.ts";

describe("OpenAPI schema generation", () => {
  test("maps valibot objects, optional fields and constraints", () => {
    expect(
      toJsonSchema(
        v.object({
          id: v.pipe(v.string(), v.regex(/^\d+$/)),
          page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
          mode: v.picklist(["new", "old"]),
        }),
      ),
    ).toEqual({
      type: "object",
      properties: {
        id: { type: "string", pattern: "^\\d+$" },
        page: { type: "integer", minimum: 1, maximum: 50 },
        mode: { enum: ["new", "old"] },
      },
      required: ["id", "mode"],
      additionalProperties: false,
    });
  });

  test("preserves loose-object additional properties", () => {
    expect(toJsonSchema(v.looseObject({ id: v.string() }))).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: true,
    });
  });

  test("describes parameters, request bodies, security and responses", () => {
    const route = defineApiRoute({
      method: "POST",
      path: "/api/v1/topics/:id/replies",
      operationId: "replyToTopic",
      summary: "Reply",
      tags: ["topics"],
      auth: "required",
      scopes: ["write:posts"],
      params: v.object({ id: v.string() }),
      query: v.object({ page: v.optional(v.number()) }),
      body: v.object({ body: v.pipe(v.string(), v.minLength(1)) }),
      responses: { 200: { description: "Created", schema: v.object({ postId: v.string() }) } },
      handler: () => Response.json({ postId: "1" }),
    });
    const document = buildOpenApiDocument([route]) as {
      openapi: string;
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const operation = document.paths["/api/v1/topics/{id}/replies"]?.post;

    expect(document.openapi).toBe("3.1.0");
    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    expect(operation?.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "page", in: "query", required: false, schema: { type: "number" } },
    ]);
    expect(operation?.requestBody).toEqual({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { body: { type: "string", minLength: 1 } },
            required: ["body"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(operation?.responses).toEqual({
      "200": {
        description: "Created",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { postId: { type: "string" } },
              required: ["postId"],
              additionalProperties: false,
            },
          },
        },
      },
    });
  });
});
