import { parse } from "libpg-query";

export type DmlCommand = "select" | "insert" | "update" | "delete";

export interface SqlPolicy {
  /** The plugin's own schema; only unqualified names and this schema are allowed. */
  readonly schema: string;
  /** Functions defined in the plugin's schema by its migrations. */
  readonly pluginFunctions: ReadonlySet<string>;
}

export interface AllowedStatement {
  readonly command: DmlCommand;
  readonly hasReturning: boolean;
}

export type SqlDenyReason = "parse" | "statement" | "schema" | "function";

export class SqlDeniedError extends Error {
  readonly reason: SqlDenyReason;

  constructor(reason: SqlDenyReason, message: string) {
    super(message);
    this.name = "SqlDeniedError";
    this.reason = reason;
  }
}

/**
 * Pure built-ins a plugin may call. Deliberately excludes anything with side effects
 * (`set_config`, `pg_notify`, `pg_sleep`, advisory locks), file or admin access (`pg_read_*`,
 * `lo_*`, `pg_terminate_backend`), and catalog introspection.
 */
const PURE_FUNCTIONS = new Set([
  "abs",
  "acos",
  "age",
  "array_agg",
  "array_append",
  "array_cat",
  "array_dims",
  "array_fill",
  "array_length",
  "array_lower",
  "array_ndims",
  "array_position",
  "array_positions",
  "array_prepend",
  "array_remove",
  "array_replace",
  "array_to_json",
  "array_to_string",
  "array_upper",
  "ascii",
  "asin",
  "atan",
  "atan2",
  "avg",
  "bit_and",
  "bit_length",
  "bit_or",
  "bit_xor",
  "bool_and",
  "bool_or",
  "btrim",
  "cardinality",
  "ceil",
  "ceiling",
  "char_length",
  "character_length",
  "chr",
  "clock_timestamp",
  "concat",
  "concat_ws",
  "convert_from",
  "convert_to",
  "corr",
  "cos",
  "cot",
  "count",
  "covar_pop",
  "covar_samp",
  "currval",
  "date_bin",
  "date_part",
  "date_trunc",
  "decode",
  "degrees",
  "div",
  "encode",
  "every",
  "exp",
  "floor",
  "format",
  "gcd",
  "generate_series",
  "gen_random_uuid",
  "initcap",
  "isfinite",
  "json_agg",
  "json_array_elements",
  "json_array_elements_text",
  "json_array_length",
  "json_build_array",
  "json_build_object",
  "json_each",
  "json_each_text",
  "json_object_agg",
  "json_object_keys",
  "json_strip_nulls",
  "json_to_record",
  "json_to_recordset",
  "json_typeof",
  "jsonb_agg",
  "jsonb_array_elements",
  "jsonb_array_elements_text",
  "jsonb_array_length",
  "jsonb_build_array",
  "jsonb_build_object",
  "jsonb_each",
  "jsonb_each_text",
  "jsonb_extract_path",
  "jsonb_extract_path_text",
  "jsonb_insert",
  "jsonb_object_agg",
  "jsonb_object_keys",
  "jsonb_path_exists",
  "jsonb_path_query",
  "jsonb_pretty",
  "jsonb_set",
  "jsonb_set_lax",
  "jsonb_strip_nulls",
  "jsonb_typeof",
  "justify_days",
  "justify_hours",
  "justify_interval",
  "left",
  "length",
  "ln",
  "log",
  "lower",
  "lpad",
  "ltrim",
  "make_date",
  "make_interval",
  "make_time",
  "make_timestamp",
  "make_timestamptz",
  "max",
  "md5",
  "min",
  "mod",
  "nextval",
  "now",
  "octet_length",
  "overlay",
  "percentile_cont",
  "percentile_disc",
  "pi",
  "position",
  "power",
  "quote_ident",
  "quote_literal",
  "quote_nullable",
  "radians",
  "random",
  "regexp_count",
  "regexp_instr",
  "regexp_like",
  "regexp_match",
  "regexp_matches",
  "regexp_replace",
  "regexp_split_to_array",
  "regexp_split_to_table",
  "repeat",
  "replace",
  "reverse",
  "right",
  "round",
  "row_to_json",
  "rpad",
  "rtrim",
  "scale",
  "sign",
  "sin",
  "split_part",
  "sqrt",
  "statement_timestamp",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "string_agg",
  "string_to_array",
  "strpos",
  "substr",
  "substring",
  "sum",
  "tan",
  "to_ascii",
  "to_char",
  "to_date",
  "to_hex",
  "to_json",
  "to_jsonb",
  "to_number",
  "to_timestamp",
  "transaction_timestamp",
  "translate",
  "trim",
  "trunc",
  "unnest",
  "upper",
  "var_pop",
  "var_samp",
  "variance",
  "width_bucket",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (isRecord(value) && isRecord(value.String) && typeof value.String.sval === "string") {
    return value.String.sval;
  }

  return undefined;
}

function functionParts(funcname: unknown): string[] | undefined {
  if (!Array.isArray(funcname) || funcname.length === 0) {
    return undefined;
  }

  const parts = funcname.map(stringValue);

  if (parts.some((part) => part === undefined)) {
    return undefined;
  }

  return (parts as string[]).map((part) => part.toLowerCase());
}

function assertRangeVar(value: unknown, policy: SqlPolicy): void {
  if (!isRecord(value)) {
    throw new SqlDeniedError("statement", "Unsupported table reference");
  }

  if (value.catalogname !== undefined && value.catalogname !== null) {
    throw new SqlDeniedError("schema", "Cross-database references are not allowed");
  }

  const schema = value.schemaname;

  if (schema !== undefined && schema !== null) {
    if (typeof schema !== "string" || schema !== policy.schema) {
      throw new SqlDeniedError("schema", "Only the plugin's own schema is accessible");
    }
  }
}

function assertFuncCall(value: unknown, policy: SqlPolicy): void {
  if (!isRecord(value)) {
    throw new SqlDeniedError("statement", "Unsupported function call");
  }

  const parts = functionParts(value.funcname);

  if (parts === undefined) {
    throw new SqlDeniedError("function", "Unsupported function call");
  }

  if (parts.length === 1) {
    const [name] = parts as [string];

    if (PURE_FUNCTIONS.has(name) || policy.pluginFunctions.has(name)) {
      return;
    }

    throw new SqlDeniedError("function", `Function ${name} is not allowed`);
  }

  if (parts.length === 2) {
    const [schema, name] = parts as [string, string];

    if (schema === policy.schema) {
      return;
    }

    if (schema === "pg_catalog" && PURE_FUNCTIONS.has(name)) {
      return;
    }

    throw new SqlDeniedError("function", `Function ${schema}.${name} is not allowed`);
  }

  throw new SqlDeniedError("function", "Qualified function calls are not allowed");
}

const NESTED_DML = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);

function walk(statement: unknown, policy: SqlPolicy): void {
  const stack: unknown[] = [statement];

  while (stack.length > 0) {
    const node = stack.pop();

    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }

    if (!isRecord(node)) {
      continue;
    }

    // Some fields (`InsertStmt.relation`, for example) embed the node's content directly
    // instead of wrapping it in `{ RangeVar: ... }`; detect both shapes.
    if (typeof node.relname === "string") {
      assertRangeVar(node, policy);
    }

    if (Array.isArray(node.funcname)) {
      assertFuncCall(node, policy);
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "RangeVar") {
        assertRangeVar(value, policy);
      } else if (key === "FuncCall") {
        assertFuncCall(value, policy);
      } else if (NESTED_DML.has(key)) {
        // PostgreSQL only allows data-modifying CTEs at the top level, and our result-row
        // wrapper would move them into a subquery; reject them instead.
        throw new SqlDeniedError("statement", "Data-modifying CTEs are not allowed");
      }

      if (typeof value === "object" && value !== null) {
        stack.push(value);
      }
    }
  }
}

function topLevelStatement(stmts: unknown): {
  readonly kind: string;
  readonly body: Record<string, unknown>;
} {
  if (!Array.isArray(stmts) || stmts.length !== 1) {
    throw new SqlDeniedError("statement", "Exactly one SQL statement is allowed");
  }

  const [first] = stmts;

  if (!isRecord(first) || !isRecord(first.stmt)) {
    throw new SqlDeniedError("statement", "SQL could not be parsed");
  }

  const keys = Object.keys(first.stmt);

  if (keys.length !== 1) {
    throw new SqlDeniedError("statement", "Unsupported SQL statement");
  }

  const [kind] = keys as [string];
  const body = first.stmt[kind];

  if (!isRecord(body)) {
    throw new SqlDeniedError("statement", "Unsupported SQL statement");
  }

  return { kind, body };
}

/**
 * Validates one runtime statement: DML against the plugin's own schema only, no session
 * commands, no DDL, and no function outside the pure/plugin allowlist. Returns the command so
 * the broker can apply a result-row limit.
 */
export async function assertAllowedSql(sql: string, policy: SqlPolicy): Promise<AllowedStatement> {
  const text = sql.trim();

  if (text === "") {
    throw new SqlDeniedError("statement", "SQL statement is empty");
  }

  if (text.length > 64 * 1024) {
    throw new SqlDeniedError("statement", "SQL statement is too long");
  }

  let parsed: unknown;

  try {
    parsed = await parse(text);
  } catch {
    throw new SqlDeniedError("parse", "SQL could not be parsed");
  }

  if (!isRecord(parsed)) {
    throw new SqlDeniedError("parse", "SQL could not be parsed");
  }

  const { kind, body } = topLevelStatement(parsed.stmts);

  let command: DmlCommand;
  let hasReturning = false;

  switch (kind) {
    case "SelectStmt": {
      if (body.intoClause !== undefined && body.intoClause !== null) {
        throw new SqlDeniedError("statement", "SELECT INTO is not allowed");
      }

      if (Array.isArray(body.lockingClause) && body.lockingClause.length > 0) {
        throw new SqlDeniedError("statement", "Row locking is not allowed");
      }

      command = "select";
      break;
    }
    case "InsertStmt":
    case "UpdateStmt":
    case "DeleteStmt": {
      command = kind === "InsertStmt" ? "insert" : kind === "UpdateStmt" ? "update" : "delete";
      hasReturning = body.returningClause !== undefined && body.returningClause !== null;
      break;
    }
    default:
      throw new SqlDeniedError("statement", "Only SELECT, INSERT, UPDATE and DELETE are allowed");
  }

  walk(body, policy);

  return { command, hasReturning };
}

/**
 * Wraps a statement so the broker never receives a result beyond the byte and row budgets.
 *
 * Postgres expands each row to JSON, measures that expanded text (`octet_length`), and
 * returns one small row containing either the JSON rows or `broker_too_large = true`. A
 * highly compressible large value is therefore measured after decompression, not by its
 * compressed storage size. A single value such as `repeat('x', 100 MB)` is never sent to
 * plugin-host. DML without `RETURNING` is executed directly because it has no rows.
 *
 * The JSON representation is the price of enforcing a cumulative budget in one execution;
 * `plugin-platform` can replace it with a typed cursor if large bigint precision matters.
 */
export function buildBoundedQuery(
  sql: string,
  statement: AllowedStatement,
  maxRows: number,
  maxBytes: number,
): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");

  if (statement.command !== "select" && !statement.hasReturning) {
    return trimmed;
  }

  const limit = maxRows + 1;
  const tooLarge = `(stats.broker_count > ${maxRows} OR stats.broker_bytes > ${maxBytes})`;

  return `
    WITH result_rows AS (${trimmed}),
    raw AS (SELECT * FROM result_rows LIMIT ${limit}),
    json_rows AS (SELECT to_jsonb(raw) AS broker_json FROM raw),
    measured AS (
      SELECT broker_json, octet_length(broker_json::text) AS broker_size
      FROM json_rows
    ),
    ordered AS (
      SELECT broker_json, broker_size, row_number() OVER () AS broker_order
      FROM measured
    ),
    stats AS (
      SELECT count(*) AS broker_count, coalesce(sum(broker_size), 0) AS broker_bytes
      FROM measured
    )
    SELECT
      ${tooLarge} AS broker_too_large,
      CASE
        WHEN ${tooLarge} THEN '[]'::jsonb
        ELSE coalesce(
          (SELECT jsonb_agg(broker_json ORDER BY broker_order) FROM ordered),
          '[]'::jsonb
        )
      END AS broker_rows
    FROM stats
  `;
}
