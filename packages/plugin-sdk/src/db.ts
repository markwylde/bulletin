/**
 * The broker's `db.query` request and result contract, including its number-precision rules
 * (ADR 0009).
 */

export interface DbQueryParams {
  readonly sql: string;
  /** Positional `$1…` parameters; never interpolate plugin input into the SQL text. */
  readonly params?: readonly unknown[];
}

/** A decimal string for an `int8`/`numeric` column (see {@link DbQueryResult}). */
export type DbDecimal = string;

/**
 * The rows a broker `db.query` returns.
 *
 * `int8` (`bigint`) and `numeric` columns come back as decimal strings, exactly as Postgres
 * printed them. JavaScript numbers cannot represent integers above 2^53 exactly, so an ID
 * such as `9007199254740993` would otherwise become `9007199254740992`; the broker keeps
 * those columns textual instead. Use `BigInt(value)` (or a decimal library) for arithmetic,
 * and compare IDs as strings or BigInts.
 *
 * `int2`/`int4`, `float4`/`float8` and other types stay JSON numbers. Values stored inside a
 * `json`/`jsonb` column keep JSON number encoding.
 */
export interface DbQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number;
  readonly command: "select" | "insert" | "update" | "delete";
}
