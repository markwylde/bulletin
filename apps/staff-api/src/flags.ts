import { bumpFlagTag } from "@bulletin/db/flags";
import {
  type FlagDefinition,
  flagAgeDays,
  isStaleFlag,
  nextFullyOnSince,
  parseFlagRules,
  parseFlagRulesInput,
} from "@bulletin/flags";
import type { SQL } from "bun";
import { type AdminLogEntry, listAdminLog, writeAdminLog } from "./admin-log.ts";

/** The admin log action recorded by every rule change. */
export const FLAG_LOG_ACTION = "flags.update";

/** A stored flag plus the derived fields the staff list displays. */
export interface FlagAdminView extends FlagDefinition {
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Whole days since the flag first appeared in the staff app. */
  readonly ageDays: number;
  /** Fully on since at least 90 days ago, so ready for removal. */
  readonly stale: boolean;
}

interface FlagRow {
  key: string;
  description: string;
  owner: string;
  default_value: boolean;
  affects_render: boolean;
  client_visible: boolean;
  rules: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  fully_on_since: Date | string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDefinition(row: FlagRow): FlagDefinition {
  return {
    key: row.key,
    description: row.description,
    owner: row.owner,
    defaultValue: row.default_value,
    affectsRender: row.affects_render,
    clientVisible: row.client_visible,
    rules: parseFlagRules(row.rules),
  };
}

function toAdminView(row: FlagRow, now: number): FlagAdminView {
  const definition = toDefinition(row);
  const createdAt = toDate(row.created_at);
  const fullyOnSince = row.fully_on_since === null ? null : toDate(row.fully_on_since);

  return {
    ...definition,
    createdAt: createdAt.toISOString(),
    updatedAt: toDate(row.updated_at).toISOString(),
    ageDays: flagAgeDays(createdAt, now),
    stale: isStaleFlag(definition, fullyOnSince, now),
  };
}

export async function listFlags(sql: SQL, now: number = Date.now()): Promise<FlagAdminView[]> {
  const rows = (await sql`
    SELECT key, description, owner, default_value, affects_render, client_visible,
           rules, created_at, updated_at, fully_on_since
    FROM core.feature_flags
    ORDER BY key
  `) as FlagRow[];

  return rows.map((row) => toAdminView(row, now));
}

export type FlagRulesSave =
  | { readonly ok: true; readonly flag: FlagAdminView }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "invalid_rules" | "not_found";
      readonly fields?: readonly string[];
    };

/**
 * Replaces one flag's ordered rules, bumps the `flags` cache tag so every process reloads
 * within a second, and records the before/after rules in the admin log (ADR 0010).
 */
export async function saveFlagRules(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
  now: number = Date.now(),
): Promise<FlagRulesSave> {
  if (!isRecord(input) || typeof input.key !== "string" || input.key.trim() === "") {
    return { ok: false, code: "invalid_request" };
  }

  const parsed = parseFlagRulesInput(input.rules);

  if (!parsed.ok) {
    return { ok: false, code: "invalid_rules", fields: parsed.fields };
  }

  return sql.begin(async (tx) => {
    const existing = (await tx`
      SELECT key, description, owner, default_value, affects_render, client_visible,
             rules, created_at, updated_at, fully_on_since
      FROM core.feature_flags
      WHERE key = ${input.key}
      FOR UPDATE
    `) as FlagRow[];

    const before = existing[0];

    if (before === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    const beforeDefinition = toDefinition(before);
    const afterDefinition: FlagDefinition = { ...beforeDefinition, rules: parsed.rules };
    const fullyOnSince = nextFullyOnSince(
      beforeDefinition,
      afterDefinition,
      before.fully_on_since === null ? null : toDate(before.fully_on_since),
      new Date(now),
    );

    const updated = (await tx`
      UPDATE core.feature_flags
      SET rules = ${parsed.rules}::jsonb,
          fully_on_since = ${fullyOnSince},
          updated_at = now()
      WHERE key = ${input.key}
      RETURNING key, description, owner, default_value, affects_render, client_visible,
                rules, created_at, updated_at, fully_on_since
    `) as FlagRow[];
    const after = updated[0];

    if (after === undefined) {
      throw new Error(`Feature flag ${input.key} disappeared during the update`);
    }

    await bumpFlagTag(tx);
    await writeAdminLog(tx, {
      actorMemberId,
      action: FLAG_LOG_ACTION,
      targetType: "flag",
      targetId: null,
      summary: {
        key: input.key,
        before: { rules: parseFlagRules(before.rules) },
        after: { rules: parsed.rules },
      },
    });

    return { ok: true, flag: toAdminView(after, now) } as const;
  });
}

/** Recent rule changes, newest first. */
export async function listFlagLog(sql: SQL, limit = 20): Promise<readonly AdminLogEntry[]> {
  return (await listAdminLog(sql, { action: FLAG_LOG_ACTION, limit })).entries;
}
