import { LOG_LEVELS, type Logger, type LogLevel } from "@bulletin/config";
import type { BrokerHandler } from "./channel.ts";
import { QueryLimitError, type QueryResult } from "./database.ts";
import { EgressDeniedError, type EgressRequest, type EgressResponse } from "./egress.ts";
import { JSON_RPC_ERRORS, RpcError } from "./protocol.ts";
import { type AllowedStatement, assertAllowedSql, SqlDeniedError } from "./sql.ts";

/** The subset of {@link PluginDatabase} the broker needs; tests provide a fake. */
export interface BrokerDatabase {
  readonly schema: string;
  readonly functions: ReadonlySet<string>;
  readonly ready: boolean;
  query(sql: string, params: readonly unknown[], statement: AllowedStatement): Promise<QueryResult>;
  close(): Promise<void>;
}

/** The subset of {@link EgressProxy} the broker needs; tests provide a fake. */
export interface BrokerEgress {
  request(input: EgressRequest): Promise<EgressResponse>;
}

export interface BrokerOptions {
  readonly database: BrokerDatabase;
  readonly egress: BrokerEgress;
  readonly logger: Logger;
}

export interface BrokerStats {
  readonly queries: number;
  readonly fetches: number;
  readonly denials: number;
  readonly logs: number;
  readonly failures: number;
}

const MAX_PARAMS = 100;
const MAX_LOG_MESSAGE = 4_096;
const MAX_LOG_FIELDS = 4_096;
const MAX_RESULT_BYTES = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RpcError(JSON_RPC_ERRORS.invalidParams, "params must be an object");
  }

  return value;
}

function parseQueryParams(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.length > MAX_PARAMS) {
    throw new RpcError(
      JSON_RPC_ERRORS.invalidParams,
      `params must be an array of at most ${MAX_PARAMS}`,
    );
  }

  for (const param of value) {
    if (
      param !== null &&
      typeof param !== "boolean" &&
      typeof param !== "number" &&
      typeof param !== "string"
    ) {
      throw new RpcError(
        JSON_RPC_ERRORS.invalidParams,
        "query parameters must be strings, numbers, booleans or null",
      );
    }
  }

  return value;
}

function parseLogLevel(value: unknown): LogLevel {
  if (typeof value !== "string" || !(LOG_LEVELS as readonly string[]).includes(value)) {
    throw new RpcError(
      JSON_RPC_ERRORS.invalidParams,
      `level must be one of: ${LOG_LEVELS.join(", ")}`,
    );
  }

  return value as LogLevel;
}

function parseLogFields(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new RpcError(JSON_RPC_ERRORS.invalidParams, "fields must be an object");
  }

  let serialized: string;

  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new RpcError(JSON_RPC_ERRORS.invalidParams, "fields must be JSON-serialisable");
  }

  if (serialized.length > MAX_LOG_FIELDS) {
    throw new RpcError(JSON_RPC_ERRORS.invalidParams, "fields are too large");
  }

  return value;
}

/**
 * Dispatches the broker's JSON-RPC methods. The database path validates every statement with
 * the AST allowlist before it reaches Postgres; the connection itself only has DML grants.
 */
export class Broker implements BrokerHandler {
  readonly #database: BrokerDatabase;
  readonly #egress: BrokerEgress;
  readonly #logger: Logger;
  #stats = { queries: 0, fetches: 0, denials: 0, logs: 0, failures: 0 };

  constructor(options: BrokerOptions) {
    this.#database = options.database;
    this.#egress = options.egress;
    this.#logger = options.logger.child({ schema: options.database.schema });
  }

  get ready(): boolean {
    return this.#database.ready;
  }

  stats(): BrokerStats {
    return { ...this.#stats };
  }

  async close(): Promise<void> {
    await this.#database.close();
  }

  async handle(request: {
    readonly method: string;
    readonly params: unknown;
    readonly pluginId: string;
  }): Promise<unknown> {
    try {
      switch (request.method) {
        case "db.query":
          return await this.#query(request.params);
        case "http.fetch":
          return await this.#fetch(request.params);
        case "log":
          return this.#log(request.params);
        default:
          throw new RpcError(JSON_RPC_ERRORS.methodNotFound, `Unknown method: ${request.method}`);
      }
    } catch (error) {
      if (error instanceof RpcError) {
        throw error;
      }

      this.#stats = { ...this.#stats, failures: this.#stats.failures + 1 };
      this.#logger.error("broker.request_failed", {
        method: request.method,
        error,
      });
      throw new RpcError(JSON_RPC_ERRORS.internal, "Broker request failed");
    }
  }

  async #query(params: unknown): Promise<unknown> {
    const record = requireObject(params);
    const sql = record.sql;

    if (typeof sql !== "string") {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, "sql must be a string");
    }

    const queryParams = parseQueryParams(record.params);
    const startedAt = performance.now();

    let statement: AllowedStatement;

    try {
      statement = await assertAllowedSql(sql, {
        schema: this.#database.schema,
        pluginFunctions: this.#database.functions,
      });
    } catch (error) {
      if (error instanceof SqlDeniedError) {
        this.#stats = { ...this.#stats, denials: this.#stats.denials + 1 };
        this.#logger.warn("broker.statement_denied", { reason: error.reason });
        throw new RpcError(JSON_RPC_ERRORS.denied, error.message, {
          reason: error.reason,
        });
      }

      throw error;
    }

    try {
      const result = await this.#database.query(sql, queryParams, statement);
      const serialized = JSON.stringify(result, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );

      if (serialized !== undefined && serialized.length > MAX_RESULT_BYTES) {
        this.#stats = { ...this.#stats, denials: this.#stats.denials + 1 };
        this.#logger.warn("broker.result_too_large");
        throw new RpcError(JSON_RPC_ERRORS.denied, "Query result is too large", {
          reason: "limit",
        });
      }

      this.#stats = { ...this.#stats, queries: this.#stats.queries + 1 };
      this.#logger.debug("broker.query", {
        command: result.command,
        rows: result.rows.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return result;
    } catch (error) {
      if (error instanceof RpcError) {
        throw error;
      }

      if (error instanceof QueryLimitError) {
        this.#stats = { ...this.#stats, denials: this.#stats.denials + 1 };
        this.#logger.warn("broker.query_limit");
        throw new RpcError(JSON_RPC_ERRORS.denied, error.message, { reason: "limit" });
      }

      this.#stats = { ...this.#stats, failures: this.#stats.failures + 1 };
      this.#logger.error("broker.query_failed", { error });
      throw new RpcError(JSON_RPC_ERRORS.internal, "Query failed");
    }
  }

  async #fetch(params: unknown): Promise<unknown> {
    const record = requireObject(params);
    const url = record.url;

    if (typeof url !== "string") {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, "url must be a string");
    }

    const method = record.method;

    if (method !== undefined && typeof method !== "string") {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, "method must be a string");
    }

    const headers = record.headers;

    if (
      headers !== undefined &&
      (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== "string"))
    ) {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, "headers must be an object of strings");
    }

    const body = record.body;

    if (body !== undefined && typeof body !== "string") {
      throw new RpcError(JSON_RPC_ERRORS.invalidParams, "body must be a string");
    }

    const startedAt = performance.now();

    try {
      const response = await this.#egress.request({
        url,
        ...(method === undefined ? {} : { method }),
        ...(headers === undefined ? {} : { headers: headers as Record<string, string> }),
        ...(body === undefined ? {} : { body }),
      });
      this.#stats = { ...this.#stats, fetches: this.#stats.fetches + 1 };
      this.#logger.debug("broker.fetch", {
        status: response.status,
        bytes: response.body.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return response;
    } catch (error) {
      if (error instanceof EgressDeniedError) {
        this.#stats = { ...this.#stats, denials: this.#stats.denials + 1 };
        this.#logger.warn("broker.egress_denied", { reason: error.reason });
        throw new RpcError(JSON_RPC_ERRORS.denied, error.message, {
          reason: error.reason,
        });
      }

      this.#stats = { ...this.#stats, failures: this.#stats.failures + 1 };
      this.#logger.error("broker.egress_failed", { error });
      throw new RpcError(JSON_RPC_ERRORS.internal, "Request failed");
    }
  }

  #log(params: unknown): null {
    const record = requireObject(params);
    const level = parseLogLevel(record.level);
    const message = record.message;

    if (typeof message !== "string" || message.length > MAX_LOG_MESSAGE) {
      throw new RpcError(
        JSON_RPC_ERRORS.invalidParams,
        `message must be a string of at most ${MAX_LOG_MESSAGE} characters`,
      );
    }

    const fields = parseLogFields(record.fields);
    this.#stats = { ...this.#stats, logs: this.#stats.logs + 1 };
    this.#logger[level]("plugin.log", { message, ...(fields === undefined ? {} : { fields }) });
    return null;
  }
}
