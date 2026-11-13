import type { ApiRoute } from "./route.ts";

type JsonSchema = Record<string, unknown>;

interface SchemaNode {
  readonly type?: string;
  readonly entries?: Readonly<Record<string, unknown>>;
  readonly wrapped?: unknown;
  readonly item?: unknown;
  readonly options?: readonly unknown[];
  readonly literal?: unknown;
  readonly pipe?: readonly unknown[];
  readonly key?: unknown;
  readonly value?: unknown;
  readonly enum?: Readonly<Record<string, unknown>>;
  readonly requirement?: unknown;
  readonly default?: unknown;
}

function node(value: unknown): SchemaNode {
  return typeof value === "object" && value !== null ? (value as SchemaNode) : {};
}

const OPTIONAL_TYPES = new Set([
  "optional",
  "nullish",
  "undefinedable",
  "exact_optional",
  "non_nullable",
  "non_optional",
]);

function isOptionalSchema(value: unknown): boolean {
  return OPTIONAL_TYPES.has(node(value).type ?? "");
}

function applyPipe(schema: JsonSchema, pipe: readonly unknown[]): void {
  for (const entry of pipe) {
    const action = node(entry);
    const requirement = action.requirement;

    switch (action.type) {
      case "integer":
      case "safe_integer":
        schema.type = "integer";
        break;
      case "min_value":
        if (typeof requirement === "number") {
          schema.minimum = requirement;
        }
        break;
      case "max_value":
        if (typeof requirement === "number") {
          schema.maximum = requirement;
        }
        break;
      case "gt_value":
        if (typeof requirement === "number") {
          schema.exclusiveMinimum = requirement;
        }
        break;
      case "lt_value":
        if (typeof requirement === "number") {
          schema.exclusiveMaximum = requirement;
        }
        break;
      case "multiple_of":
        if (typeof requirement === "number") {
          schema.multipleOf = requirement;
        }
        break;
      case "min_length":
        if (typeof requirement === "number") {
          schema.minLength = requirement;
        }
        break;
      case "max_length":
        if (typeof requirement === "number") {
          schema.maxLength = requirement;
        }
        break;
      case "regex":
        if (requirement instanceof RegExp) {
          schema.pattern = requirement.source;
        }
        break;
      case "non_empty":
        if (schema.type === "array") {
          schema.minItems = 1;
        } else {
          schema.minLength = 1;
        }
        break;
      case "email":
        schema.format = "email";
        break;
      case "url":
        schema.format = "uri";
        break;
      case "uuid":
        schema.format = "uuid";
        break;
      case "iso_date":
        schema.format = "date";
        break;
      case "iso_date_time":
      case "iso_timestamp":
        schema.format = "date-time";
        break;
      default:
        break;
    }
  }
}

/** Mirrors the valibot subset the API routes use into JSON Schema for OpenAPI 3.1. */
export function toJsonSchema(value: unknown): JsonSchema {
  const schema = node(value);
  let result: JsonSchema;

  switch (schema.type) {
    case "object":
    case "strict_object":
    case "loose_object":
    case "object_with_rest": {
      const entries = Object.entries(schema.entries ?? {});
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];

      for (const [name, entry] of entries) {
        properties[name] = toJsonSchema(entry);

        if (!isOptionalSchema(entry)) {
          required.push(name);
        }
      }

      result = { type: "object", properties, additionalProperties: false };

      if (required.length > 0) {
        result.required = required;
      }
      break;
    }
    case "array":
      result = { type: "array", items: toJsonSchema(schema.item) };
      break;
    case "tuple":
      result = {
        type: "array",
        prefixItems: (schema.options ?? []).map((entry) => toJsonSchema(entry)),
      };
      break;
    case "union":
    case "variant":
      result = { anyOf: (schema.options ?? []).map((entry) => toJsonSchema(entry)) };
      break;
    case "literal":
      result = { const: schema.literal };
      break;
    case "picklist":
    case "enum":
      result = {
        enum:
          schema.type === "picklist"
            ? [...(schema.options ?? [])]
            : Object.values(schema.enum ?? {}),
      };
      break;
    case "string":
      result = { type: "string" };
      break;
    case "number":
      result = { type: "number" };
      break;
    case "boolean":
      result = { type: "boolean" };
      break;
    case "bigint":
      result = { type: "string", pattern: "^\\d+$" };
      break;
    case "date":
      result = { type: "string", format: "date-time" };
      break;
    case "null":
      result = { type: "null" };
      break;
    case "record":
      result = { type: "object", additionalProperties: toJsonSchema(schema.value) };
      break;
    case "optional":
    case "undefinedable":
    case "exact_optional":
    case "non_nullable":
    case "non_optional":
    case "readonly":
      result = toJsonSchema(schema.wrapped);
      break;
    case "nullable":
    case "nullish":
      result = { anyOf: [toJsonSchema(schema.wrapped), { type: "null" }] };
      break;
    case "unknown":
    case "any":
    case "custom":
      result = {};
      break;
    default:
      result = {};
      break;
  }

  if (Array.isArray(schema.pipe)) {
    applyPipe(result, schema.pipe);
  }

  if (schema.default !== undefined) {
    result.default = schema.default;
  }

  return result;
}

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function pathParameterNames(path: string): readonly string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1] ?? "");
}

function objectEntries(value: unknown): Readonly<Record<string, unknown>> | null {
  const schema = node(value);
  return schema.entries ?? null;
}

function parametersFor(route: ApiRoute): readonly JsonSchema[] {
  const parameters: JsonSchema[] = [];
  const params = objectEntries(route.params);

  for (const name of pathParameterNames(route.path)) {
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: params?.[name] === undefined ? { type: "string" } : toJsonSchema(params[name]),
    });
  }

  for (const [name, entry] of Object.entries(objectEntries(route.query) ?? {})) {
    parameters.push({
      name,
      in: "query",
      required: !isOptionalSchema(entry),
      schema: toJsonSchema(entry),
    });
  }

  return parameters;
}

function responsesFor(route: ApiRoute): JsonSchema {
  const responses: Record<string, JsonSchema> = {};

  for (const [status, response] of Object.entries(route.responses)) {
    responses[status] =
      response.schema === undefined
        ? { description: response.description }
        : {
            description: response.description,
            content: { "application/json": { schema: toJsonSchema(response.schema) } },
          };
  }

  return responses;
}

/** Builds the OpenAPI 3.1 document from the route registry (ADR 0016). */
export function buildOpenApiDocument(routes: readonly ApiRoute[]): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};

  for (const route of routes) {
    const path = openApiPath(route.path);
    const parameters = parametersFor(route);
    const operation: JsonSchema = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
      responses: responsesFor(route),
      security: route.auth === "required" ? [{ bearerAuth: [] }] : [{}, { bearerAuth: [] }],
    };

    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    if (route.body !== undefined) {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: toJsonSchema(route.body) } },
      };
    }

    const methods = paths[path] ?? {};
    paths[path] = methods;
    methods[route.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Bulletin API",
      version: "1.0.0",
      description:
        "Read and write board content on behalf of an API key's principal. Authentication is `Authorization: Bearer blt_<prefix>_<secret>`.",
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "blt_<prefix>_<secret>",
        },
      },
    },
  };
}
