import { parse } from "libpg-query";
import {
  assertFuncCall,
  assertRangeVar,
  functionParts,
  isRecord,
  SqlDeniedError,
  type SqlPolicy,
} from "./sql.ts";

/**
 * Migration validation (ADR 0009). Plugin migrations run as the plugin owner inside one
 * transaction, but the owner role can create objects, so the SQL is parsed and restricted:
 * no session commands, `DO` blocks, role changes, extensions, `SECURITY DEFINER`, or
 * non-transactional DDL, and the same function/table allowlists as runtime statements.
 *
 * plpgsql bodies cannot be parsed as SQL. They are scanned for side-effecting built-ins and
 * dynamic `EXECUTE`, which is the only way a body could hide a call the runtime allowlist
 * would otherwise reject. SQL-standard bodies (`BEGIN ATOMIC`) are parsed by libpg-query and
 * checked with the normal AST walk.
 */

export type MigrationDenyReason = "parse" | "statement" | "session" | "function" | "schema";

export class MigrationDeniedError extends Error {
  readonly reason: MigrationDenyReason;

  constructor(reason: MigrationDenyReason, message: string) {
    super(message);
    this.name = "MigrationDeniedError";
    this.reason = reason;
  }
}

export interface MigrationPolicy extends SqlPolicy {
  readonly runtimeRole: string;
  readonly ownerRole: string;
}

/** Statements and nodes that must never appear in a plugin migration. */
const DENIED_NODES = new Set([
  "AlterDatabaseStmt",
  "AlterRoleSetStmt",
  "AlterRoleStmt",
  "AlterSystemStmt",
  "CheckPointStmt",
  "CopyStmt",
  "ClusterStmt",
  "CreateAmStmt",
  "CreateCastStmt",
  "CreateDatabaseStmt",
  "CreateExtensionStmt",
  "CreateFdwStmt",
  "CreateForeignTableStmt",
  "CreateOpClassStmt",
  "CreateOpFamilyStmt",
  "CreatePublicationStmt",
  "CreateSchemaStmt",
  "CreateServerStmt",
  "CreateSubscriptionStmt",
  "CreateTableSpaceStmt",
  "CreateTransformStmt",
  "CreateUserMappingStmt",
  "DiscardStmt",
  "DoStmt",
  "DropDatabaseStmt",
  "ListenStmt",
  "NotifyStmt",
  "ReindexStmt",
  "TransactionStmt",
  "UnlistenStmt",
  "VacuumStmt",
  "VariableSetStmt",
  "VariableShowStmt",
]);

const SESSION_NODES = new Set([
  "AlterRoleSetStmt",
  "AlterRoleStmt",
  "AlterSystemStmt",
  "CheckPointStmt",
  "CopyStmt",
  "DiscardStmt",
  "DoStmt",
  "ListenStmt",
  "NotifyStmt",
  "TransactionStmt",
  "UnlistenStmt",
  "VariableSetStmt",
  "VariableShowStmt",
]);
const ALLOWED_LANGUAGES = new Set(["sql", "plpgsql"]);

/**
 * Patterns forbidden in a plpgsql body. `EXECUTE` would let a function assemble SQL the
 * parser never sees, so it is rejected rather than guessed at.
 */
const FORBIDDEN_BODY =
  /\b(?:set_config|current_setting|pg_notify|pg_sleep(?:_for|_until)?|pg_(?:try_)?advisory_\w+|pg_terminate_backend|pg_cancel_backend|pg_read_(?:binary_)?file\w*|pg_ls_dir|pg_stat_file|pg_reload_conf|pg_rotate_logfile|lo_\w+|dblink\w*|execute)\b/i;

function stringValue(value: unknown): string | undefined {
  if (isRecord(value) && isRecord(value.String) && typeof value.String.sval === "string") {
    return value.String.sval;
  }

  return undefined;
}

function optionValue(options: unknown, name: string): unknown {
  if (!Array.isArray(options)) {
    return undefined;
  }

  for (const option of options) {
    if (!isRecord(option) || !isRecord(option.DefElem)) {
      continue;
    }

    if (option.DefElem.defname === name) {
      return option.DefElem.arg;
    }
  }

  return undefined;
}

function functionName(body: Record<string, unknown>): string | undefined {
  const parts = functionParts(body.funcname);
  return parts?.at(-1);
}

function declareFunction(
  body: Record<string, unknown>,
  policy: MigrationPolicy,
  defined: Set<string>,
): void {
  const name = functionName(body);

  if (name === undefined) {
    throw new MigrationDeniedError("function", "Function has no valid name");
  }

  const parts = functionParts(body.funcname) ?? [];

  if (parts.length > 2 || (parts.length === 2 && parts[0] !== policy.schema)) {
    throw new MigrationDeniedError("schema", "Functions must live in the plugin schema");
  }

  const security = optionValue(body.options, "security");

  if (isRecord(security) && isRecord(security.Boolean) && security.Boolean.boolval === true) {
    throw new MigrationDeniedError(
      "statement",
      "SECURITY DEFINER functions are not allowed in plugin migrations",
    );
  }

  if (optionValue(body.options, "set") !== undefined) {
    throw new MigrationDeniedError("session", "Function SET clauses are not allowed");
  }

  const languageValue = optionValue(body.options, "language");
  const language = isRecord(languageValue) ? stringValue(languageValue) : undefined;

  if (language === undefined || !ALLOWED_LANGUAGES.has(language.toLowerCase())) {
    throw new MigrationDeniedError("statement", "Only sql and plpgsql functions are allowed");
  }

  if (language.toLowerCase() === "plpgsql") {
    const asValue = optionValue(body.options, "as");

    if (!isRecord(asValue) || !isRecord(asValue.List) || !Array.isArray(asValue.List.items)) {
      throw new MigrationDeniedError("function", "plpgsql function has no body");
    }

    for (const item of asValue.List.items) {
      const bodyText = stringValue(item);

      if (bodyText === undefined) {
        continue;
      }

      const match = FORBIDDEN_BODY.exec(bodyText);

      if (match !== null) {
        throw new MigrationDeniedError(
          "function",
          `plpgsql body calls ${match[0]}, which plugin functions may not use`,
        );
      }
    }
  }

  defined.add(name);
}

function assertGrant(body: Record<string, unknown>, policy: MigrationPolicy): void {
  const grantees = body.grantees;

  if (Array.isArray(grantees)) {
    for (const grantee of grantees) {
      if (!isRecord(grantee) || !isRecord(grantee.RoleSpec)) {
        throw new MigrationDeniedError("statement", "Unsupported GRANT grantee");
      }

      const spec = grantee.RoleSpec;

      if (spec.roletype !== "ROLESPEC_CSTRING" || typeof spec.rolename !== "string") {
        throw new MigrationDeniedError("statement", "Grants to PUBLIC or roles are not allowed");
      }

      if (spec.rolename !== policy.runtimeRole && spec.rolename !== policy.ownerRole) {
        throw new MigrationDeniedError("statement", "Grants must target the plugin's own roles");
      }
    }
  }

  if (body.targtype === "ACL_TARGET_ALL_IN_SCHEMA") {
    const schemas = Array.isArray(body.objs) ? body.objs : [];

    for (const schema of schemas) {
      if (stringValue(schema) !== policy.schema) {
        throw new MigrationDeniedError("schema", "GRANT may only target the plugin schema");
      }
    }
  }

  if (body.objtype === "OBJECT_FUNCTION" && Array.isArray(body.objects)) {
    for (const object of body.objects) {
      const name =
        isRecord(object) && isRecord(object.ObjectWithArgs)
          ? functionParts(object.ObjectWithArgs.objname)
          : undefined;

      if (name === undefined || (name.length === 2 && name[0] !== policy.schema)) {
        throw new MigrationDeniedError("schema", "GRANT may only target plugin functions");
      }
    }
  }
}

function walk(node: unknown, policy: MigrationPolicy, defined: Set<string>): void {
  const stack: unknown[] = [node];

  while (stack.length > 0) {
    const current = stack.pop();

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    if (!isRecord(current)) {
      continue;
    }

    // Some nodes embed a RangeVar inline, e.g. `CreateStmt.relation` and trigger targets.
    if (typeof current.relname === "string") {
      assertRangeVar(current, policy);
    }

    for (const [key, value] of Object.entries(current)) {
      if (DENIED_NODES.has(key)) {
        throw new MigrationDeniedError(
          SESSION_NODES.has(key) ? "session" : "statement",
          `${key} is not allowed in plugin migrations`,
        );
      }

      if (key === "IndexStmt" && isRecord(value) && value.concurrent === true) {
        throw new MigrationDeniedError(
          "statement",
          "CREATE INDEX CONCURRENTLY is not allowed (migrations run in one transaction)",
        );
      }

      if (
        key === "CreateStmt" &&
        isRecord(value) &&
        isRecord(value.relation) &&
        value.relation.relpersistence === "t"
      ) {
        throw new MigrationDeniedError("statement", "Temporary tables are not allowed");
      }

      if (key === "CreateFunctionStmt" && isRecord(value)) {
        declareFunction(value, policy, defined);
      }

      if (key === "CreateTrigStmt" && isRecord(value)) {
        const name = functionParts(value.funcname);

        if (
          name === undefined ||
          (name.length === 2 && name[0] !== policy.schema) ||
          !defined.has(name.at(-1) ?? "")
        ) {
          throw new MigrationDeniedError(
            "function",
            "Triggers may only call functions defined by the plugin",
          );
        }
      }

      if (key === "GrantStmt" && isRecord(value)) {
        assertGrant(value, policy);
      }

      if (key === "RangeVar") {
        assertRangeVar(value, policy);
      } else if (key === "FuncCall") {
        assertFuncCall(value, { ...policy, pluginFunctions: defined });
      } else if (typeof value === "object" && value !== null) {
        stack.push(value);
      }
    }
  }
}

/**
 * Validates every statement in a migration. Throws {@link MigrationDeniedError} before any
 * SQL reaches Postgres; the caller runs the whole migration in one transaction.
 */
export async function assertAllowedMigration(sql: string, policy: MigrationPolicy): Promise<void> {
  if (sql.trim() === "") {
    throw new MigrationDeniedError("statement", "Migration is empty");
  }

  if (sql.length > 1024 * 1024) {
    throw new MigrationDeniedError("statement", "Migration is too large");
  }

  let parsed: unknown;

  try {
    parsed = await parse(sql);
  } catch {
    throw new MigrationDeniedError("parse", "Migration SQL could not be parsed");
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.stmts)) {
    throw new MigrationDeniedError("parse", "Migration SQL could not be parsed");
  }

  // Collect every function first so SQL bodies may reference functions defined later in the
  // same migration; each declaration is still validated when its statement is walked.
  const defined = new Set<string>();
  collectFunctionNames(parsed.stmts, policy, defined);

  for (const statement of parsed.stmts) {
    if (!isRecord(statement) || !isRecord(statement.stmt)) {
      throw new MigrationDeniedError("statement", "Unsupported migration statement");
    }

    try {
      walk(statement.stmt, policy, defined);
    } catch (error) {
      if (error instanceof SqlDeniedError) {
        throw new MigrationDeniedError(error.reason, error.message);
      }

      throw error;
    }
  }
}

function collectFunctionNames(node: unknown, policy: MigrationPolicy, names: Set<string>): void {
  const stack: unknown[] = [node];

  while (stack.length > 0) {
    const current = stack.pop();

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    if (!isRecord(current)) {
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      if (key === "CreateFunctionStmt" && isRecord(value)) {
        const name = functionName(value);
        const parts = functionParts(value.funcname) ?? [];

        if (name !== undefined && (parts.length === 1 || parts[0] === policy.schema)) {
          names.add(name);
        }
      }

      if (typeof value === "object" && value !== null) {
        stack.push(value);
      }
    }
  }
}
