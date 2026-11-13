/**
 * A deliberately small JSON Schema checker for tests. It covers the subset `toJsonSchema`
 * (apps/user-api/src/api/openapi.ts) emits for API responses, so a test can assert a real
 * response body against the generated OpenAPI document without adding a dependency (ADR 0001).
 */

type Schema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function checkObject(schema: Schema, value: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const name of required) {
    if (!(name in value)) {
      errors.push(`${path}.${name}: required property is missing`);
    }
  }

  for (const [name, entry] of Object.entries(properties)) {
    if (name in value) {
      errors.push(...validateJsonSchema(entry, value[name], `${path}.${name}`));
    }
  }

  const additional = schema.additionalProperties;

  for (const name of Object.keys(value)) {
    if (name in properties) {
      continue;
    }

    if (additional === false) {
      errors.push(`${path}.${name}: property is not described by the schema`);
    } else if (isRecord(additional)) {
      errors.push(...validateJsonSchema(additional, value[name], `${path}.${name}`));
    }
  }

  return errors;
}

/** Returns one message per violation; an empty array means the value matches the schema. */
export function validateJsonSchema(schema: unknown, value: unknown, path = "$"): string[] {
  if (!isRecord(schema)) {
    return [];
  }

  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some(
      (branch) => validateJsonSchema(branch, value, path).length === 0,
    );

    return matched ? [] : [`${path}: matches none of the anyOf branches`];
  }

  const errors: string[] = [];

  if ("const" in schema && value !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof schema.type === "string") {
    if (!matchesType(schema.type, value)) {
      errors.push(`${path}: expected ${schema.type}, got ${describeValue(value)}`);
      return errors;
    }

    if (schema.type === "object" && isRecord(value)) {
      errors.push(...checkObject(schema, value, path));
    }

    if (schema.type === "array" && Array.isArray(value) && schema.items !== undefined) {
      value.forEach((item, index) => {
        errors.push(...validateJsonSchema(schema.items, item, `${path}[${index}]`));
      });
    }
  }

  return errors;
}
